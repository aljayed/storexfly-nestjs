// Isolated PostgreSQL check; never reads application database credentials.
// Run after npm run build. Set PG_BIN if pg_config is not on PATH.
const fs = require('node:fs/promises');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createRequire } = require('node:module');
const assert = require('node:assert/strict');
process.chdir(path.resolve(__dirname, '..'));
const req = createRequire(path.join(process.cwd(), 'package.json'));
const postgres = req('postgres');
const { drizzle } = req('drizzle-orm/postgres-js');
const { getTableConfig } = req('drizzle-orm/pg-core');
const schema = req(path.join(process.cwd(), 'dist/src/database/schema'));
const { SettlementsService } = req(path.join(process.cwd(), 'dist/src/modules/settlements/settlements.service'));
const { ServiceFeesService } = req(path.join(process.cwd(), 'dist/src/modules/service-fees/service-fees.service'));
const bin = process.env.PG_BIN || execFileSync('pg_config', ['--bindir'], { encoding: 'utf8' }).trim();
const port = Number(process.env.FEE_TEST_PORT || 58427);
assert.ok(Number.isInteger(port) && port >= 1024 && port <= 65535);
const quote = value => '"' + value.replaceAll('"', '""') + '"';
const literal = value => "'" + value.replaceAll("'", "''") + "'";
(async () => {
  const dir = await fs.mkdtemp('/tmp/hoomri-fees-pg-');
  let started = false, client;
  try {
    execFileSync(path.join(bin, 'initdb'), ['-D', dir, '-U', 'fee_test', '--auth=trust', '--no-locale', '--encoding=UTF8'], { stdio: 'ignore' });
    execFileSync(path.join(bin, 'pg_ctl'), ['-D', dir, '-l', path.join(dir, 'server.log'), '-o', `-h 127.0.0.1 -p ${port} -k ${dir}`, '-w', 'start'], { stdio: 'ignore' });
    started = true;
    client = postgres({ host: '127.0.0.1', port, database: 'postgres', username: 'fee_test', max: 5, onnotice: () => {} });
    const enums = new Set();
    const excluded = new Set(['platform_fee_bp', 'dues_paid_at', 'suspended_for', 'dues_over_since', 'dues_deducted_cents', 'reseller_margin_cents:SETTLEMENT', 'processing_shortfall_cents', 'paid_with_period']);
    for (const key of ['shops', 'orders', 'paymentMethods', 'paymentTransactions', 'settlements', 'paymentLinks', 'tradeDisputes']) {
      const config = getTableConfig(schema[key]);
      const columns = [];
      for (const col of config.columns) {
        if (excluded.has(col.name) || (config.name === 'settlements' && col.name === 'reseller_margin_cents')) continue;
        const type = col.getSQLType();
        const enumColumn = col.baseColumn ?? col;
        const enumType = enumColumn.getSQLType();
        if (enumColumn.columnType === 'PgEnumColumn' && !enums.has(enumType)) {
          await client.unsafe(`CREATE TYPE ${enumType} AS ENUM (${enumColumn.enumValues.map(literal).join(',')})`);
          enums.add(enumType);
        }
        columns.push(`${quote(col.name)} ${type}${col.name === 'id' ? ' PRIMARY KEY DEFAULT gen_random_uuid()' : ''}`);
      }
      await client.unsafe(`CREATE TABLE ${quote(config.name)} (${columns.join(',')})`);
    }
    await client.unsafe('CREATE UNIQUE INDEX settlements_shop_period_unique_idx ON settlements(shop_id, period)');
    const supplier = '00000000-0000-4000-8000-000000000001';
    const retail = '00000000-0000-4000-8000-000000000002';
    await client`INSERT INTO shops (id,name,handle,currency,business_type) VALUES (${supplier},'Supplier','supplier','BDT','wholesale'),(${retail},'Retail','retail','BDT','retail')`;
    await client`INSERT INTO payment_methods(code,title,kind,gateway,fee_bp,enabled) VALUES ('cod','Cash','cod','none',0,true),('card','Card','card','sslcommerz',350,true)`;
    await client`INSERT INTO orders(shop_id,reference,total_cents) VALUES (${retail},'#old-free',100000)`;
    for (const migration of ['0115_service_fee.sql','0116_settlement_dues_deduction.sql','0117_trade_fee_policy.sql']) {
      await client.unsafe(await fs.readFile(path.join(process.cwd(),'src/database/migrations',migration),'utf8'));
      if (migration === '0116_settlement_dues_deduction.sql') await client`INSERT INTO orders(shop_id,reference,total_cents) VALUES (${supplier},'#old-trade',100000)`;
    }
    assert.equal((await client`SELECT platform_fee_bp FROM orders WHERE reference='#old-free'`)[0].platform_fee_bp, 0);
    assert.equal((await client`SELECT fee_bp FROM payment_methods WHERE code='card'`)[0].fee_bp, 450);
    assert.equal((await client`SELECT platform_fee_bp FROM orders WHERE reference='#old-trade'`)[0].platform_fee_bp,0);
    await client`INSERT INTO orders(shop_id,reference,customer_name,total_cents,advance_cents,reseller_margin_cents,payment_method,pay,status,placed_at,delivered_at,delivery_mode,platform_fee_bp)
      VALUES (${supplier},'#old','Buyer',100000,0,0,'card','Paid','Delivered','2026-10-20','2026-10-20','carrybee',0),
      (${supplier},'#new','Buyer',400000,0,0,'card','Paid','Delivered','2026-11-20','2026-11-20','carrybee',0),
      (${supplier},'#cash','Buyer',1000000,0,0,'cod','Paid','Delivered','2026-11-21','2026-11-21','carrybee',450)`;
    // The wholesale cash debt is reseller money, not a sales commission.
    await client`UPDATE orders SET platform_fee_bp=0,reseller_shop_id=${retail},reseller_margin_cents=45000 WHERE reference='#cash'`;
    const db = drizzle(client, { schema });
    const methods = new Map((await db.query.paymentMethods.findMany()).map(m => [m.code,m]));
    const feeService = new ServiceFeesService(db, { byCode: async () => methods }, {}, { send: async () => { throw Error('No outbound mail in a local test') } });
    const svc = new SettlementsService(db, { requireById: async () => ({ id:supplier,name:'Supplier',handle:'supplier',currency:'BDT' }) }, { byCode: async () => methods }, feeService);
    const proof = { data:'data:application/pdf;base64,AAAA',name:'local-test.pdf' };
    // A normal transfer also settles a held earlier cycle and offsets 450 taka.
    await svc.decide(supplier,'2026-12',true,undefined,proof);
    const displayed = await svc.forPlatform('2026-12');
    assert.equal(displayed.rows.find(r=>r.shopId===supplier).transfer,4325);
    const resellerPayout=displayed.rows.find(r=>r.shopId===retail);
    assert.equal(resellerPayout.payout,450);
    assert.equal(resellerPayout.fees,0);
    assert.ok((await client`SELECT dues_paid_at FROM orders WHERE reference='#cash'`)[0].dues_paid_at);
    assert.equal(displayed.totals[0].paidPayout,4325);
    const earlier = await svc.forPlatform('2026-11');
    assert.equal(earlier.rows[0].transfer,0);
    const snapshots = await client`SELECT period,payout_cents,dues_deducted_cents,proofs FROM settlements ORDER BY period`;
    assert.equal(snapshots.length,2);
    assert.equal(snapshots.reduce((s,r)=>s+r.payout_cents-r.dues_deducted_cents,0),432500);
    assert.equal((await client`SELECT sum(amount_cents)::integer AS paid FROM service_fee_payments`)[0].paid,45000);
    await svc.decide(supplier,'2026-12',true,undefined,proof);
    assert.equal((await client`SELECT count(*)::integer AS n FROM service_fee_payments`)[0].n,1);
    // Two concurrent confirmations still produce one transfer and one offset.
    await svc.decide(supplier,'2026-12',false);
    await Promise.all([svc.decide(supplier,'2026-12',true,undefined,proof),svc.decide(supplier,'2026-12',true,undefined,proof)]);
    assert.equal((await client`SELECT count(*)::integer AS n FROM service_fee_payments`)[0].n,1);
    assert.equal((await client`SELECT count(*)::integer AS n FROM settlements`)[0].n,2);
    await assert.rejects(svc.decide(supplier,'2026-11',false),/combined transfer/);
    await svc.decide(supplier,'2026-12',false);
    assert.equal((await client`SELECT count(*)::integer AS n FROM settlements`)[0].n,0);
    assert.equal((await client`SELECT count(*)::integer AS n FROM service_fee_payments`)[0].n,0);
    console.log('PASS: migrations 0115–0117, legacy free order, 4.5% gateway rate, real PostgreSQL payout/offset writes, repeated and concurrent confirmations, grouped undo, fee-free reseller release and rollback.');
  } finally {
    if (client) await client.end();
    if (started) execFileSync(path.join(bin,'pg_ctl'),['-D',dir,'-m','fast','-w','stop'],{stdio:'ignore'});
    await fs.rm(dir,{recursive:true,force:true});
  }
})().catch(error => { console.error(error.message); process.exitCode=1 });
