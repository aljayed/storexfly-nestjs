import type { Request } from 'express';

/**
 * Who is asking, as far as an anonymous endpoint can tell: the client address
 * Express resolved (see the trust-proxy note in main.ts), a device id the
 * storefront persists in local storage, and the account behind the bearer
 * token when there is one.
 *
 * The device id is client-supplied and therefore trivially cleared - which is
 * exactly why it is only ever read alongside the IP, and never on its own.
 */
export interface CheckoutCaller {
  ip: string | null;
  device: string | null;
  accountId: string | null;
}

/** Header the storefront sends its persistent device id in. */
export const DEVICE_HEADER = 'x-device-id';

export function callerFrom(
  req: Request,
  accountId: string | null,
): CheckoutCaller {
  const device = req.headers[DEVICE_HEADER];
  return {
    ip: req.ip ?? null,
    device: (Array.isArray(device) ? device[0] : device)?.slice(0, 100) ?? null,
    accountId,
  };
}
