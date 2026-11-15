// Build first. Writes local previews only; no email is sent.
const { mkdtemp, writeFile } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { serviceFeeEmail } = require('../dist/src/modules/service-fees/service-fee-email');
(async () => {
  const dir = await mkdtemp(join(tmpdir(), 'hoomri-balance-emails-'));
  for (const event of ['over', 'suspended', 'restored']) {
    const email = serviceFeeEmail({
      event, shopName: 'Humri', ownerName: 'Shoaib Rahman', amount: '৳2,185',
      payBy: '18 November', feePercent: 4.5, webUrl: 'https://hoomri.com',
    });
    await writeFile(join(dir, `${event}.html`), email.html);
    await writeFile(join(dir, `${event}.txt`), `${email.subject}\n\n${email.text}\n`);
  }
  console.log(dir);
})().catch(error => { console.error(error); process.exitCode = 1; });
