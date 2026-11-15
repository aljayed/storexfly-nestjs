// Isolated upgrade check. Never reads application credentials or touches a running database.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const postgres = require('postgres');
const bin = process.env.PG_BIN || execFileSync('pg_config', ['--bindir'], { encoding: 'utf8' }).trim();
const port = Number(process.env.COURIER_TEST_PORT || 58428);
assert.ok(Number.isInteger(port) && port >= 1024 && port <= 65535);
(async () => {
  const dir = await fs.mkdtemp('/tmp/hoomri-courier-pg-');
  let started = false, db;
  try {
    execFileSync(path.join(bin, 'initdb'), ['-D', dir, '-U', 'courier_test', '--auth=trust', '--no-locale', '--encoding=UTF8'], { stdio: 'ignore' });
    execFileSync(path.join(bin, 'pg_ctl'), ['-D', dir, '-l', path.join(dir, 'server.log'), '-o', `-h 127.0.0.1 -p ${port} -k ${dir}`, '-w', 'start'], { stdio: 'ignore' });
    started = true;
    db = postgres({ host: '127.0.0.1', port, database: 'postgres', username: 'courier_test', onnotice: () => {} });
    await db.unsafe(`CREATE TABLE platform_settings (
      id integer PRIMARY KEY, courier_required boolean, carrybee_enabled boolean,
      carrybee_client_id text, carrybee_client_secret text, carrybee_client_context text,
      carrybee_production boolean DEFAULT false, carrybee_webhook_secret text DEFAULT 'keep-webhook',
      steadfast_enabled boolean DEFAULT true, steadfast_api_key text DEFAULT 'old-key', steadfast_secret_key text DEFAULT 'old-secret',
      pathao_enabled boolean DEFAULT true, pathao_production boolean DEFAULT true,
      pathao_client_id text DEFAULT 'old-client', pathao_client_secret text DEFAULT 'old-secret',
      pathao_username text DEFAULT 'old-user', pathao_password text DEFAULT 'old-password'
    );
    CREATE TABLE shop_courier_stores (provider text, store_id text);
    CREATE TABLE shop_couriers (provider text, secret_key text);
    CREATE TABLE orders (courier_provider text, courier_consignment_id text, courier_status text, total_cents integer);
    CREATE TABLE settlements (period text, payout_cents integer, proofs jsonb);
    INSERT INTO platform_settings (id,courier_required,carrybee_enabled,carrybee_client_id,carrybee_client_secret,carrybee_client_context) VALUES
      (1,true,true,'client','secret','context'), (2,true,false,'client','secret','context'),
      (3,true,true,'client',null,'context'), (4,true,true,'client','   ','context');
    INSERT INTO shop_courier_stores VALUES ('carrybee','cb-pickup'),('pathao','old-pickup');
    INSERT INTO shop_couriers VALUES ('steadfast','old-secret');
    INSERT INTO orders VALUES ('steadfast','old-consignment','delivered',50000),('pathao','old-parcel','pending',65000),('carrybee','cb-parcel','created',70000),(null,'legacy-parcel','delivered',10000);
    INSERT INTO settlements VALUES ('2026-11',45000,'[{"name":"receipt.pdf"}]');`);
    const ordersBefore = await db`SELECT * FROM orders`;
    const settlementsBefore = await db`SELECT * FROM settlements`;
    const migration = await fs.readFile(path.join(__dirname, '../src/database/migrations/0118_carrybee_only.sql'), 'utf8');
    await db.begin(tx => tx.unsafe(migration));
    // Reapplying is safe, including after the legacy table has gone.
    await db.begin(tx => tx.unsafe(migration));
    const settings = await db`SELECT * FROM platform_settings ORDER BY id`;
    assert.deepEqual(settings.map(s => s.courier_required), [true, false, false, false]);
    assert.deepEqual(settings.map(s => s.carrybee_enabled), [true, false, true, true]);
    assert.equal(settings[0].carrybee_client_secret, 'secret');
    assert.equal(settings[0].carrybee_webhook_secret, 'keep-webhook');
    assert.equal(Object.keys(settings[0]).some(k => /^(steadfast|pathao)_/.test(k)), false);
    assert.deepEqual([...(await db`SELECT * FROM shop_courier_stores`)], [{ provider: 'carrybee', store_id: 'cb-pickup' }]);
    assert.equal((await db`SELECT to_regclass('shop_couriers') AS legacy`)[0].legacy, null);
    assert.deepEqual([...(await db`SELECT * FROM orders`)], [...ordersBefore]);
    assert.deepEqual([...(await db`SELECT * FROM settlements`)], [...settlementsBefore]);
    console.log('Passed courier migration, repeat application, disabled/incomplete CarryBee policy, credential cleanup, pickup stores and historical order/settlement preservation.');
  } finally {
    if (db) await db.end();
    if (started) execFileSync(path.join(bin, 'pg_ctl'), ['-D', dir, '-m', 'immediate', '-w', 'stop'], { stdio: 'ignore' });
    await fs.rm(dir, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
