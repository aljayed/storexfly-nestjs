// Real HTTP/validation/database wiring against temporary PostgreSQL; no live gateways.
// Run after the backend build. PG_BIN may point at a local PostgreSQL bin directory.
require('reflect-metadata');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const postgres = require('postgres');
const { drizzle } = require('drizzle-orm/postgres-js');
const { getTableConfig } = require('drizzle-orm/pg-core');
const { Test } = require('@nestjs/testing');
const { ValidationPipe, ForbiddenException } = require('@nestjs/common');
const request = require('supertest');
const compiled = p => require(path.join(__dirname, '../dist/src', p));
const schema = compiled('database/schema');
const { DRIZZLE } = compiled('database/database.constants');
const { PaymentMethodsService } = compiled('modules/settlements/payment-methods.service');
const { PaymentMethodsController } = compiled('modules/settlements/payment-methods.controller');
const { GatewaySettingsService } = compiled('modules/gateways/gateway-settings.service');
const { PlatformGatewaysController } = compiled('modules/platform/platform-gateways.controller');
const { PlatformJwtAuthGuard } = compiled('common/guards/platform-jwt-auth.guard');
const bin = process.env.PG_BIN || execFileSync('pg_config', ['--bindir'], { encoding: 'utf8' }).trim();
const port = Number(process.env.PAYMENT_SETTINGS_TEST_PORT || 58429);
assert.ok(Number.isInteger(port) && port >= 1024 && port <= 65535);
(async () => {
  const dir = await fs.mkdtemp('/tmp/hoomri-payment-settings-pg-');
  let started = false, client, app;
  try {
    execFileSync(path.join(bin, 'initdb'), ['-D', dir, '-U', 'settings_test', '--auth=trust', '--no-locale', '--encoding=UTF8'], { stdio: 'ignore' });
    execFileSync(path.join(bin, 'pg_ctl'), ['-D', dir, '-l', path.join(dir, 'server.log'), '-o', `-h 127.0.0.1 -p ${port} -k ${dir}`, '-w', 'start'], { stdio: 'ignore' });
    started = true;
    client = postgres({ host: '127.0.0.1', port, database: 'postgres', username: 'settings_test', max: 10, onnotice: () => {} });
    await client.unsafe(`CREATE TYPE payment_method AS ENUM ('mbank','card','cod'); CREATE TYPE payment_gateway AS ENUM ('none','bkash','sslcommerz');`);
    for (const key of ['platformSettings', 'paymentMethods']) {
      const config = getTableConfig(schema[key]);
      const cols = config.columns.filter(c => c.name !== 'archived_at').map(c => {
        const def = c.name === 'id' ? ' PRIMARY KEY DEFAULT gen_random_uuid()'
          : typeof c.default === 'boolean' || typeof c.default === 'number' ? ` DEFAULT ${c.default}`
          : typeof c.default === 'string' ? ` DEFAULT '${c.default.replaceAll("'", "''")}'`
          : ['created_at', 'updated_at'].includes(c.name) ? ' DEFAULT now()' : '';
        return `"${c.name}" ${c.getSQLType()}${def}`;
      });
      await client.unsafe(`CREATE TABLE "${config.name}" (${cols.join(',')})`);
    }
    await client.unsafe('CREATE UNIQUE INDEX payment_methods_code_unique_idx ON payment_methods(code)');
    const migration = await fs.readFile(path.join(__dirname, '../src/database/migrations/0119_archive_payment_methods.sql'), 'utf8');
    await client.unsafe(migration);
    await client.unsafe(migration);
    const db = drizzle(client, { schema });
    const testing = await Test.createTestingModule({
      controllers: [PaymentMethodsController, PlatformGatewaysController],
      providers: [PaymentMethodsService, GatewaySettingsService, { provide: DRIZZLE, useValue: db }],
    }).overrideGuard(PlatformJwtAuthGuard).useValue({ canActivate(ctx) {
      if (ctx.switchToHttp().getRequest().headers.authorization === 'Bearer fixture-operator') return true;
      throw new ForbiddenException('Operator required');
    } }).compile();
    app = testing.createNestApplication({ logger: false });
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true, transformOptions: { enableImplicitConversion: false } }));
    await app.init();
    const http = request(app.getHttpServer());
    const auth = req => req.set('Authorization', 'Bearer fixture-operator');
    const all = '/platform/payment-methods';
    for (const route of [`${all}/all`, '/platform/gateways']) await http.get(route).expect(403);
    await http.post(all).send({ kind: 'card', title: 'Unauthorized' }).expect(403);
    const initial = (await auth(http.get(`${all}/all`)).expect(200)).body;
    const cod = initial.methods.find(m => m.kind === 'cod');
    for (const body of [{ enabled: false }, { feePercent: 4.5 }, { gateway: 'bkash' }]) await auth(http.patch(`${all}/${cod.id}`)).send(body).expect(400);
    await auth(http.delete(`${all}/${cod.id}`)).expect(409);
    const gateway = testing.get(GatewaySettingsService);
    await auth(http.patch('/platform/gateways/bkash')).send({ enabled: true }).expect(400);
    await auth(http.patch('/platform/gateways/sslcommerz')).send({ enabled: true, storeId: 'store' }).expect(400);
    let response = await auth(http.patch('/platform/gateways/sslcommerz')).send({ enabled: true, sandbox: true, storeId: 'store', storePassword: 'ssl-secret' }).expect(200);
    assert.equal(response.body.sslcommerz.configured, true);
    assert.equal(JSON.stringify(response.body).includes('ssl-secret'), false);
    await auth(http.patch('/platform/gateways/bkash')).send({ enabled: true, appKey: 'key', appSecret: 'app-secret', username: 'user', password: 'bk-secret' }).expect(200);
    await auth(http.patch('/platform/gateways/bkash')).send({ username: 'new-user' }).expect(200);
    for (const provider of ['bkash', 'sslcommerz']) {
      await auth(http.patch(`/platform/gateways/${provider}`)).send({}).expect(200);
    }
    assert.equal((await gateway.bkashConfig()).appSecret, 'app-secret');
    await auth(http.patch('/platform/gateways/bkash')).send({ appSecret: '' }).expect(400);
    assert.equal((await gateway.bkashConfig()).appSecret, 'app-secret');
    for (const [url, body] of [['/platform/gateways/bkash', { enabled: null }], ['/platform/gateways/sslcommerz', { storeId: null }]]) await auth(http.patch(url)).send(body).expect(400);
    response = await auth(http.post(all)).send({ kind: 'card', title: 'Online card', gateway: 'sslcommerz', enabled: false }).expect(201);
    const card = response.body;
    assert.equal(card.feePercent, 4.5);
    assert.equal(card.gateway, 'sslcommerz');
    assert.equal(card.enabled, false);
    assert.equal((await http.get(all)).body.methods.some(m => m.id === card.id), false);
    await auth(http.patch(`${all}/${card.id}`)).send({ enabled: true }).expect(200);
    assert.ok((await http.get(all)).body.methods.some(m => m.id === card.id));
    await auth(http.patch('/platform/gateways/sslcommerz')).send({ enabled: false }).expect(200);
    assert.equal(await gateway.sslcommerzConfig(), null);
    assert.equal((await gateway.sslcommerzConfig(true)).storePassword, 'ssl-secret');
    assert.equal((await http.get(all)).body.methods.some(m => m.id === card.id), false);
    await auth(http.patch('/platform/gateways/sslcommerz')).send({ enabled: true }).expect(200);
    // A catalog edit cannot recategorize previously collected money.
    await auth(http.patch(`${all}/${card.id}`)).send({ gateway: 'none' }).expect(400);
    assert.equal((await testing.get(PaymentMethodsService).byCode()).get(card.code).gateway, 'sslcommerz');
    for (const body of [{ enabled: null }, { title: null }, { feePercent: null }, { gateway: null }, { title: ' ' }]) await auth(http.patch(`${all}/${card.id}`)).send(body).expect(400);
    await auth(http.post(all)).send({ kind: 'card', title: 'Wrong route', gateway: 'bkash' }).expect(400);
    await auth(http.post(all)).send({ kind: 'mbank', title: 'Wrong fee', gateway: 'none', feePercent: 4.5 }).expect(400);
    await auth(http.post(all)).send({ kind: 'mbank', title: 'Wrong fee', gateway: 'bkash', feePercent: 1 }).expect(400);
    response = await auth(http.patch(`${all}/${card.id}`)).send({ title: 'Renamed card', subtitle: null, subtitleIcons: false }).expect(200);
    assert.equal(response.body.subtitle, null);
    assert.equal(response.body.subtitleIcons, false);
    // Archived codes stay in accounting and are never offered or reused.
    await auth(http.delete(`${all}/${card.id}`)).expect(200);
    assert.equal((await auth(http.get(`${all}/all`))).body.methods.some(m => m.id === card.id), false);
    assert.equal((await http.get(all)).body.methods.some(m => m.id === card.id), false);
    const historical = (await testing.get(PaymentMethodsService).byCode()).get(card.code);
    assert.equal(historical.gateway, 'sslcommerz');
    assert.equal(historical.feeBp, 450);
    assert.ok(historical.archivedAt);
    await auth(http.patch(`${all}/${card.id}`)).send({ enabled: true }).expect(404);
    response = await auth(http.post(all)).send({ kind: 'card', title: 'Online card', gateway: 'sslcommerz' }).expect(201);
    assert.notEqual(response.body.code, card.code);
    // Concurrent title collisions resolve to unique stable codes.
    const concurrent = await Promise.all(Array.from({ length: 3 }, () => auth(http.post(all)).send({ kind: 'mbank', title: 'Concurrent wallet', gateway: 'bkash' })));
    assert.ok(concurrent.every(r => r.status === 201));
    assert.equal(new Set(concurrent.map(r => r.body.code)).size, 3);
    const raced = concurrent[0].body;
    await Promise.all([auth(http.patch(`${all}/${raced.id}`)).send({ enabled: true }), auth(http.delete(`${all}/${raced.id}`))]);
    assert.equal((await http.get(all)).body.methods.some(m => m.id === raced.id), false);
    response = await auth(http.patch(`${all}/banner`)).send({ banner: '  Payout notice  ' }).expect(200);
    assert.equal(response.body.banner, 'Payout notice');
    assert.equal((await http.get(all)).body.banner, 'Payout notice');
    await auth(http.patch(`${all}/banner`)).send({ banner: null }).expect(200);
    assert.equal((await http.get(all)).body.banner, null);
    await auth(http.patch(`${all}/banner`)).send({ banner: 'x'.repeat(601) }).expect(400);
    console.log('Passed payment settings HTTP wiring, operator guards, validation, gateway readiness/secrets, immutable collectors, create/update/archive, concurrent changes, history retention and banner save/reset on PostgreSQL.');
  } finally {
    if (app) await app.close();
    if (client) await client.end();
    if (started) execFileSync(path.join(bin, 'pg_ctl'), ['-D', dir, '-m', 'immediate', '-w', 'stop'], { stdio: 'ignore' });
    await fs.rm(dir, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
