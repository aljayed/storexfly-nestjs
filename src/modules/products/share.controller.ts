import { Controller, Get, Header, Param } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiExcludeController } from '@nestjs/swagger';
import { Public } from '../../common/decorators/public.decorator';
import { ShopsService } from '../shops/shops.service';
import { ProductsService } from './products.service';

/** Currency code → symbol for the share-preview description line. */
const SYMBOLS: Record<string, string> = {
  BDT: '৳',
  USD: '$',
  EUR: '€',
  GBP: '£',
  INR: '₹',
  PKR: '₨',
};

const escapeHtml = (s: string): string =>
  s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

/**
 * Server-rendered Open Graph previews for link crawlers.
 *
 * F-commerce selling happens by dropping product links into Facebook groups,
 * pages, and WhatsApp/Messenger threads - but the storefront is a client-side
 * SPA, so crawlers see an empty shell and shares lose their photo/price card.
 * Nginx routes known crawler user-agents fetching a product URL here instead;
 * the page carries the product's OG meta plus a redirect for any human that
 * lands on it directly.
 */
@ApiExcludeController()
@Controller('share')
export class ShareController {
  constructor(
    private readonly products: ProductsService,
    private readonly shops: ShopsService,
    private readonly config: ConfigService,
  ) {}

  @Public()
  @Get('product/:handle/:slug')
  @Header('Content-Type', 'text/html; charset=utf-8')
  // Short-lived: crawlers re-scrape occasionally, and price/stock move.
  @Header('Cache-Control', 'public, max-age=300')
  async product(
    @Param('handle') handle: string,
    @Param('slug') slug: string,
  ): Promise<string> {
    const [shop, product] = await Promise.all([
      this.shops.requireLiveByHandle(handle),
      this.products.getBySlug(handle, slug),
    ]);

    const webUrl = this.config
      .getOrThrow<string>('app.webUrl')
      .replace(/\/$/, '');
    const pageUrl = `${webUrl}/shop/${encodeURIComponent(handle)}/p/${encodeURIComponent(slug)}`;

    // First uploaded photo, absolute. Legacy inline base64 rows are skipped -
    // a data: URL is useless to a crawler.
    const raw = product.images?.[0];
    let image = raw?.startsWith('http')
      ? raw
      : raw?.startsWith('/')
        ? `${webUrl}${raw}`
        : undefined;

    // Chat apps pick the card layout from the image dimensions: big images get
    // the huge edge-to-edge photo card, small ones get a compact thumbnail
    // beside the title/price text. A 240×240 square (media proxy crops) lands
    // in the compact range everywhere: WhatsApp needs <300px wide, Facebook/
    // Messenger show the side square between 200×200 and 600×315.
    const thumb = image?.includes('/media/');
    if (thumb) {
      image += '?s=240';
    }

    const symbol = SYMBOLS[shop.currency] ?? `${shop.currency} `;
    const priceLine =
      product.listingType === 'showcase' && !product.price
        ? ''
        : `${symbol}${product.price.toLocaleString('en-US')}${product.unit ? ` per ${product.unit}` : ''}`;
    const blurb = product.blurb.replace(/\s+/g, ' ').trim().slice(0, 160);
    const description = [priceLine, blurb].filter(Boolean).join(' - ');

    const title = `${product.name} - ${shop.name}`;
    const locale = shop.language === 'bn' ? 'bn_BD' : 'en_US';

    const t = escapeHtml(title);
    const d = escapeHtml(description);
    const u = escapeHtml(pageUrl);
    return `<!doctype html>
<html lang="${shop.language ?? 'en'}">
<head>
<meta charset="utf-8">
<title>${t}</title>
<link rel="canonical" href="${u}">
<meta name="description" content="${d}">
<meta property="og:type" content="product">
<meta property="og:site_name" content="${escapeHtml(shop.name)}">
<meta property="og:title" content="${t}">
<meta property="og:description" content="${d}">
<meta property="og:url" content="${u}">
<meta property="og:locale" content="${locale}">
${image ? `<meta property="og:image" content="${escapeHtml(image)}">\n${thumb ? '<meta property="og:image:width" content="240">\n<meta property="og:image:height" content="240">\n' : ''}<meta name="twitter:card" content="summary">\n<meta name="twitter:image" content="${escapeHtml(image)}">` : `<meta name="twitter:card" content="summary">`}
<meta name="twitter:title" content="${t}">
<meta name="twitter:description" content="${d}">
${priceLine ? `<meta property="product:price:amount" content="${product.price}">\n<meta property="product:price:currency" content="${escapeHtml(shop.currency)}">` : ''}
<meta http-equiv="refresh" content="0;url=${u}">
</head>
<body>
<p><a href="${u}">${t}</a></p>
</body>
</html>
`;
  }
}
