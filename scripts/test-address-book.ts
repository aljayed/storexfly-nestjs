// Exercises the real PostgreSQL constraints and service in an isolated schema.
import 'dotenv/config';
import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import * as schema from '../src/database/schema';
import { BuyerAddressesService } from '../src/modules/buyer/buyer-addresses.service';
import { SaveBuyerAddressDto } from '../src/modules/buyer/dto/buyer-address.dto';

async function main() {
  const url = process.env.DATABASE_URL!;
  assert.ok(
    ['localhost', '127.0.0.1', '[::1]'].includes(new URL(url).hostname),
    'Use a local test database',
  );
  const schemaName = `address_test_${randomUUID().replace(/-/g, '')}`;
  const admin = postgres(url, { max: 1 });
  await admin.unsafe(`CREATE SCHEMA "${schemaName}"`);
  const client = postgres(url, {
    max: 5,
    connection: { search_path: schemaName },
  });
  try {
    await client.unsafe(`CREATE TABLE users (
      id uuid PRIMARY KEY, name varchar(160), phone varchar(24),
      address_line text, address_city varchar(120), address_pincode varchar(24),
      geo jsonb, updated_at timestamptz DEFAULT now()
    )`);
    const owner = randomUUID(),
      other = randomUUID(),
      concurrent = randomUUID();
    await client`INSERT INTO users(id, name, phone, address_line, address_city) VALUES
      (${owner}, 'Account owner', '01712345678', 'Old house', 'Dhaka'),
      (${other}, 'Other account', '1812345678', NULL, NULL),
      (${concurrent}, 'Concurrent account', '1912345678', NULL, NULL)`;
    await client.unsafe(
      await readFile(
        'src/database/migrations/0092_buyer_addresses.sql',
        'utf8',
      ),
    );
    const service = new BuyerAddressesService(drizzle(client, { schema }));
    let rows = await service.list(owner);
    assert.equal(rows.length, 1, 'Migration preserves legacy addresses');
    assert.equal(rows[0].isDefault, true);
    assert.equal(rows[0].phone, '1712345678');
    assert.equal('userId' in rows[0], false);
    const legacyId = rows[0].id;
    const home: SaveBuyerAddressDto = {
      name: 'Delivery recipient',
      phone: '1812345678',
      address: 'House 10, Road 3',
      city: 'Gazipur',
      label: 'Office',
      pincode: '1700',
    };
    rows = await service.save(owner, home);
    const officeId = rows.find((a) => a.label === 'Office')!.id;
    assert.equal(
      rows.find((a) => a.id === legacyId)!.isDefault,
      true,
      'Adding an address keeps the default',
    );
    rows = await service.setDefault(owner, officeId);
    assert.equal(rows[0].id, officeId);
    assert.equal(rows.filter((a) => a.isDefault).length, 1);
    const [identity] =
      await client`SELECT name, phone, address_city FROM users WHERE id = ${owner}`;
    assert.equal(identity.name, 'Account owner');
    assert.equal(
      identity.phone,
      '01712345678',
      'Recipient phone cannot overwrite account identity',
    );
    assert.equal(
      identity.address_city,
      'Gazipur',
      'Default mirrors into legacy autofill',
    );
    rows = await service.save(
      owner,
      { ...home, address: 'Updated office', isDefault: false },
      officeId,
    );
    assert.equal(
      rows[0].isDefault,
      true,
      'Editing cannot unset the only default',
    );
    assert.equal(rows[0].address, 'Updated office');
    for (const attack of [
      () => service.save(other, home, officeId),
      () => service.remove(other, officeId),
      () => service.setDefault(other, officeId),
    ]) {
      await assert.rejects(
        attack,
        (error: { getStatus?: () => number }) => error.getStatus?.() === 404,
        'Addresses are scoped to the current account',
      );
    }
    assert.equal((await service.list(other)).length, 0);
    await service.save(other, home);
    assert.equal(
      (await service.list(other))[0].isDefault,
      true,
      'First address becomes default',
    );
    await Promise.all(
      Array.from({ length: 4 }, (_, i) =>
        service.save(concurrent, {
          ...home,
          label: String(i),
          isDefault: true,
        }),
      ),
    );
    const parallel = await service.list(concurrent);
    assert.equal(parallel.length, 4);
    assert.equal(
      parallel.filter((a) => a.isDefault).length,
      1,
      'Concurrent saves keep exactly one default',
    );
    await Promise.all(
      parallel.map((a) => service.setDefault(concurrent, a.id)),
    );
    assert.equal(
      (await service.list(concurrent)).filter((a) => a.isDefault).length,
      1,
    );
    rows = await service.remove(owner, officeId);
    assert.equal(
      rows[0].id,
      legacyId,
      'Deleting the default promotes the remaining address',
    );
    assert.equal(rows[0].isDefault, true);
    await service.remove(owner, legacyId);
    assert.deepEqual(
      await service.list(owner),
      [],
      'Deleted addresses never reappear',
    );
    const [cleared] =
      await client`SELECT address_line, address_city FROM users WHERE id = ${owner}`;
    assert.equal(cleared.address_line, null);
    assert.equal(cleared.address_city, null);
    for (const phone of ['01712 345678', '+880 1712 345678', '০১৭১২৩৪৫৬৭৮']) {
      const dto = plainToInstance(SaveBuyerAddressDto, { ...home, phone });
      assert.equal((await validate(dto)).length, 0);
      assert.equal(dto.phone, '1712345678');
    }
    for (const patch of [
      { name: '  ' },
      { phone: '123' },
      { address: '' },
      { city: '' },
      { userId: other },
      { label: 'x'.repeat(41) },
    ]) {
      const dto = plainToInstance(SaveBuyerAddressDto, { ...home, ...patch });
      assert.ok(
        (await validate(dto, { whitelist: true, forbidNonWhitelisted: true }))
          .length > 0,
      );
    }
    console.log(
      'PASS: legacy migration, persistence, CRUD, ownership, defaults, concurrent writes, recipient identity isolation, validation and Bengali phone normalization.',
    );
  } finally {
    await client.end();
    await admin.unsafe(`DROP SCHEMA "${schemaName}" CASCADE`);
    await admin.end();
  }
}
void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
