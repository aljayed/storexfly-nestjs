import { createHash } from 'node:crypto';
import { SslcommerzService } from './sslcommerz.service';
import type { GatewaySettingsService } from './gateway-settings.service';

/**
 * The `verify_sign` check is what separates SSLCommerz talking from anyone on
 * the internet who guessed a `tran_id`. An IPN only ever acts on a callback
 * that passes it, and a failing one can void a buyer's pending order, so this
 * pins the hash construction: which fields go in, the md5'd store password
 * riding along as one of them, and the alphabetical order they are joined in.
 *
 * The expected signature is built here from SSLCommerz's documented steps
 * rather than copied from the implementation, so a change to either side of
 * the algorithm shows up as a failure instead of agreeing with itself.
 */
describe('SslcommerzService.verifySignature', () => {
  const STORE_ID = 'teststore';
  const STORE_PASSWORD = 'qwerty';

  function service(config: { storeId: string; storePassword: string } | null) {
    const settings = {
      sslcommerzConfig: () => Promise.resolve(config),
    } as unknown as GatewaySettingsService;
    return new SslcommerzService(settings);
  }

  const md5 = (v: string) => createHash('md5').update(v).digest('hex');

  /** SSLCommerz's documented construction, written out independently. */
  function sign(
    fields: Record<string, string>,
    verifyKey: string,
    password = STORE_PASSWORD,
  ): string {
    const included: Record<string, string> = {};
    for (const name of verifyKey.split(',')) {
      if (fields[name] !== undefined) included[name] = fields[name];
    }
    included.store_passwd = md5(password);
    const hashString = Object.keys(included)
      .sort()
      .map((k) => `${k}=${included[k]}`)
      .join('&');
    return md5(hashString);
  }

  const VERIFY_KEY = 'amount,bank_tran_id,currency,status,store_id,tran_id';
  const FIELDS: Record<string, string> = {
    amount: '125.00',
    bank_tran_id: '2508181530SSLCZ1234',
    currency: 'BDT',
    status: 'VALID',
    store_id: STORE_ID,
    tran_id: '1043-A1B2C3D4-MSYSGLHE',
    // Not named by verify_key, so it must not enter the hash.
    card_type: 'VISA-Dutch Bangla',
  };

  const signed = {
    ...FIELDS,
    verify_key: VERIFY_KEY,
    verify_sign: sign(FIELDS, VERIFY_KEY),
  };

  it('accepts a callback SSLCommerz really signed', async () => {
    await expect(
      service({
        storeId: STORE_ID,
        storePassword: STORE_PASSWORD,
      }).verifySignature(signed),
    ).resolves.toBe('valid');
  });

  // The whole point: a forged callback naming a real tran_id decides nothing.
  it('rejects a callback whose signed fields were edited in flight', async () => {
    const tampered = { ...signed, amount: '1.00' };
    await expect(
      service({
        storeId: STORE_ID,
        storePassword: STORE_PASSWORD,
      }).verifySignature(tampered),
    ).resolves.toBe('invalid');
  });

  it('rejects a signature minted with a different store password', async () => {
    const forged = {
      ...FIELDS,
      verify_key: VERIFY_KEY,
      verify_sign: sign(FIELDS, VERIFY_KEY, 'not-our-password'),
    };
    await expect(
      service({
        storeId: STORE_ID,
        storePassword: STORE_PASSWORD,
      }).verifySignature(forged),
    ).resolves.toBe('invalid');
  });

  // Fields outside verify_key are not covered by the hash, so changing one
  // must not invalidate an otherwise genuine callback.
  it('ignores fields the verify_key does not name', async () => {
    const extra = { ...signed, card_type: 'MASTER-Brac Bank', risk_level: '0' };
    await expect(
      service({
        storeId: STORE_ID,
        storePassword: STORE_PASSWORD,
      }).verifySignature(extra),
    ).resolves.toBe('valid');
  });

  // 'unsigned' is a third answer on purpose: the redirect leg treats it as
  // "no evidence either way" rather than as proof of forgery, while the IPN
  // - which always carries a signature - refuses it.
  it('reports a callback carrying no signature as unsigned', async () => {
    const svc = service({ storeId: STORE_ID, storePassword: STORE_PASSWORD });
    await expect(svc.verifySignature(FIELDS)).resolves.toBe('unsigned');
    await expect(
      svc.verifySignature({ ...FIELDS, verify_sign: signed.verify_sign }),
    ).resolves.toBe('unsigned');
  });
});
