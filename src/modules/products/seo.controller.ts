import { Controller, Get, Header, Inject } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiExcludeController } from '@nestjs/swagger';
import { and, desc, eq, gt } from 'drizzle-orm';
import { Public } from '../../common/decorators/public.decorator';
import { DRIZZLE } from '../../database/database.constants';
import type { DrizzleDB } from '../../database/drizzle.types';
import { products, shops } from '../../database/schema';

/** XML text nodes: the five predefined entities, per the sitemap spec. */
const escapeXml = (s: string): string =>
  s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');

/**
 * Crawler-facing discovery endpoints.
 *
 * The storefront is a client-rendered SPA, so nothing links a search engine to
 * a product except the shop page it sits on - a catalog only reachable by
 * rendering JavaScript two levels deep gets crawled slowly and unevenly. The
 * sitemap hands Google the whole live catalog as flat URLs instead, which is
 * the single highest-leverage thing an SPA can do for indexing.
 *
 * Deliberately NOT the same mechanism as {@link ShareController}: that one
 * serves crawlers a *different* page than humans get (fine for a Facebook link
 * card, which only ever wants the OG tags). Search engines get the real SPA and
 * render it themselves - this only tells them which URLs exist.
 */
@ApiExcludeController()
@Controller('seo')
export class SeoController {
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDB,
    private readonly config: ConfigService,
  ) {}

  @Public()
  @Get('sitemap.xml')
  @Header('Content-Type', 'application/xml; charset=utf-8')
  // Sellers add products all day; an hour keeps new listings discoverable
  // without rebuilding the document on every crawler hit.
  @Header('Cache-Control', 'public, max-age=3600')
  async sitemap(): Promise<string> {
    const webUrl = this.config
      .getOrThrow<string>('app.webUrl')
      .replace(/\/$/, '');

    const [shopRows, productRows] = await Promise.all([
      this.db.query.shops.findMany({
        where: eq(shops.live, true),
        columns: { handle: true, updatedAt: true },
        orderBy: [desc(shops.createdAt)],
      }),
      // Only what a shopper could actually land on and buy: a live shop's
      // in-stock listings. Indexing a sold-out or hidden page earns a bounce
      // and teaches Google the domain is low quality.
      this.db
        .select({
          handle: shops.handle,
          slug: products.slug,
          updatedAt: products.updatedAt,
        })
        .from(products)
        .innerJoin(shops, eq(products.shopId, shops.id))
        .where(and(eq(shops.live, true), gt(products.stock, 0)))
        .orderBy(desc(products.updatedAt)),
    ]);

    const url = (loc: string, lastmod: Date, priority: string) =>
      `  <url>\n    <loc>${escapeXml(loc)}</loc>\n` +
      `    <lastmod>${lastmod.toISOString().slice(0, 10)}</lastmod>\n` +
      `    <priority>${priority}</priority>\n  </url>`;

    const now = new Date();
    const entries = [
      url(`${webUrl}/`, now, '0.5'),
      ...shopRows.map((s) =>
        url(
          `${webUrl}/shop/${encodeURIComponent(s.handle)}`,
          s.updatedAt,
          '0.8',
        ),
      ),
      // Products are the pages worth ranking - they carry the price, the
      // photos and the reviews someone searching a product name is after.
      ...productRows.map((p) =>
        url(
          `${webUrl}/shop/${encodeURIComponent(p.handle)}/p/${encodeURIComponent(p.slug)}`,
          p.updatedAt,
          '1.0',
        ),
      ),
    ];

    return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${entries.join('\n')}\n</urlset>\n`;
  }
}
