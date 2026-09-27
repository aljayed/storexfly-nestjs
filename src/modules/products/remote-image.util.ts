import { lookup as dnsLookup, type LookupAddress } from 'dns';
import { get as httpGet, type IncomingMessage } from 'http';
import { get as httpsGet } from 'https';
import { BlockList, isIP, type LookupFunction } from 'net';

/**
 * Fetch a picture a seller named by URL in an import file ("Main Image" in a
 * Daraz export, say) and hand it back as a `data:` URL, which the storage
 * service then absorbs like any photo picked in the browser.
 *
 * The URL comes from a spreadsheet, so it is untrusted: this is a request the
 * server makes on a stranger's behalf. Every connection is checked against
 * private and link-local ranges *at connect time* - the check sits in the
 * socket's DNS lookup, so a name that resolves to a public address for a
 * pre-check and a private one a moment later (DNS rebinding) is still caught.
 * Redirects are followed by hand so each hop goes through the same door.
 *
 * The bytes decide the type, not the server's Content-Type: only the raster
 * formats a product gallery shows are accepted, never SVG (script) or HTML.
 */

/** Thrown for any URL we will not or could not fetch; `message` is for sellers. */
export class RemoteImageError extends Error {}

const MAX_REDIRECTS = 3;

const blocked = new BlockList();
for (const [net, bits] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['224.0.0.0', 3],
] as const) {
  blocked.addSubnet(net, bits, 'ipv4');
}
for (const [net, bits] of [
  ['::', 128],
  ['::1', 128],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
] as const) {
  blocked.addSubnet(net, bits, 'ipv6');
}

export function isBlockedAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return blocked.check(address, 'ipv4');
  if (family === 6) {
    // An IPv4-mapped address (::ffff:10.0.0.1) is judged as the IPv4 it is.
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
    if (mapped) return blocked.check(mapped[1], 'ipv4');
    return blocked.check(address, 'ipv6');
  }
  return true;
}

/** A DNS lookup that refuses to hand a private address to the socket. */
const guardedLookup: LookupFunction = (hostname, options, callback) => {
  dnsLookup(hostname, options, (err, address, family) => {
    if (err) return callback(err, address, family);
    const list: LookupAddress[] = Array.isArray(address)
      ? address
      : [{ address, family: family ?? 4 }];
    if (!list.length || list.some((a) => isBlockedAddress(a.address))) {
      return callback(
        new RemoteImageError('This address is not allowed.'),
        address,
        family,
      );
    }
    callback(null, address, family);
  });
};

/** Magic-byte sniff for the formats a product gallery can show. */
export function sniffImageMime(buf: Buffer): string | null {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff)
    return 'image/jpeg';
  if (
    buf.length >= 8 &&
    buf
      .subarray(0, 8)
      .equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  )
    return 'image/png';
  if (
    buf.length >= 6 &&
    /^GIF8[79]a$/.test(buf.subarray(0, 6).toString('latin1'))
  )
    return 'image/gif';
  if (
    buf.length >= 12 &&
    buf.subarray(0, 4).toString('latin1') === 'RIFF' &&
    buf.subarray(8, 12).toString('latin1') === 'WEBP'
  )
    return 'image/webp';
  if (
    buf.length >= 12 &&
    buf.subarray(4, 8).toString('latin1') === 'ftyp' &&
    /^avi[fs]$/.test(buf.subarray(8, 12).toString('latin1'))
  )
    return 'image/avif';
  return null;
}

function parseUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new RemoteImageError('This is not a valid web address.');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new RemoteImageError('Only http:// and https:// links can be used.');
  }
  if (url.username || url.password) {
    throw new RemoteImageError('Links with a login in them are not allowed.');
  }
  if (url.port && !['80', '443', '8080', '8443'].includes(url.port)) {
    throw new RemoteImageError('This address is not allowed.');
  }
  // An IP literal never goes through DNS, so the lookup guard can't see it.
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (isIP(host) && isBlockedAddress(host)) {
    throw new RemoteImageError('This address is not allowed.');
  }
  return url;
}

function request(url: URL, timeoutMs: number): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => {
    const get = url.protocol === 'https:' ? httpsGet : httpGet;
    const req = get(
      url,
      {
        lookup: guardedLookup,
        timeout: timeoutMs,
        headers: {
          // Some CDNs refuse requests without a browser-ish accept header.
          accept: 'image/avif,image/webp,image/png,image/jpeg,image/*;q=0.8',
          'user-agent': 'HoomriImport/1.0 (+https://hoomri.com)',
        },
      },
      resolve,
    );
    req.on('timeout', () =>
      req.destroy(new RemoteImageError('The image took too long to download.')),
    );
    req.on('error', reject);
  });
}

function readCapped(
  res: IncomingMessage,
  maxBytes: number,
  timeoutMs: number,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const timer = setTimeout(() => {
      res.destroy();
      reject(new RemoteImageError('The image took too long to download.'));
    }, timeoutMs);
    res.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) {
        clearTimeout(timer);
        res.destroy();
        reject(
          new RemoteImageError(
            `The image is larger than ${Math.round(maxBytes / 1_000_000)} MB.`,
          ),
        );
        return;
      }
      chunks.push(chunk);
    });
    res.on('end', () => {
      clearTimeout(timer);
      resolve(Buffer.concat(chunks));
    });
    res.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

/**
 * Download `raw` and return it as a base64 `data:` URL. Throws
 * {@link RemoteImageError} with a seller-readable reason on any failure.
 */
export async function fetchImageAsDataUrl(
  raw: string,
  { timeoutMs = 8_000, maxBytes = 2_000_000 } = {},
): Promise<string> {
  let url = parseUrl(raw);
  for (let hop = 0; ; hop++) {
    let res: IncomingMessage;
    try {
      res = await request(url, timeoutMs);
    } catch (err) {
      if (err instanceof RemoteImageError) throw err;
      throw new RemoteImageError('The image could not be reached.');
    }
    const status = res.statusCode ?? 0;
    if (status >= 300 && status < 400 && res.headers.location) {
      res.resume();
      if (hop >= MAX_REDIRECTS) {
        throw new RemoteImageError('The link redirects too many times.');
      }
      url = parseUrl(new URL(res.headers.location, url).toString());
      continue;
    }
    if (status !== 200) {
      res.resume();
      throw new RemoteImageError(
        status === 404
          ? 'The image was not found at this link (404).'
          : `The image server answered with an error (${status}).`,
      );
    }
    let body: Buffer;
    try {
      body = await readCapped(res, maxBytes, timeoutMs);
    } catch (err) {
      if (err instanceof RemoteImageError) throw err;
      throw new RemoteImageError('The image download was interrupted.');
    }
    const mime = sniffImageMime(body);
    if (!mime) {
      throw new RemoteImageError(
        'This link is not a JPG, PNG, WebP, GIF or AVIF picture.',
      );
    }
    return `data:${mime};base64,${body.toString('base64')}`;
  }
}
