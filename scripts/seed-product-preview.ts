import 'dotenv/config';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { products, shops, users } from '../src/database/schema';
import type { ProductVariantCombination } from '../src/database/schema/products.schema';

// A local, additive fixture. Never clears existing demo or customer data.
// Run: npx ts-node -r tsconfig-paths/register scripts/seed-product-preview.ts
async function main() {
  const url = new URL(process.env.DATABASE_URL ?? '');
  if (process.env.NODE_ENV === 'production' || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
    throw new Error('This preview fixture is restricted to a local development database.');
  }
  const client = postgres(url.toString(), { max: 1 });
  const db = drizzle(client);
  try {
    await db.transaction(async (tx) => {
      const ownerId = 'e28a5473-3ae1-4f21-8ef0-547300000001';
      const shopId = 'e28a5473-3ae1-4f21-8ef0-547300000002';
      const productId = 'e28a5473-3ae1-4f21-8ef0-547300000003';
      await tx.insert(users).values({ id: ownerId, publicId: 'HMDEMO5473', name: 'Daylight local demo' }).onConflictDoNothing();
      await tx.insert(shops).values({
        id: shopId, ownerId, name: 'Daylight Studio · Demo', handle: 'daylight-demo',
        tagline: 'A local preview shop for trying product options.', cat: 'Fashion',
        brand: '#44634b', brandSoft: '#edf2e9', language: 'en', live: true, plan: 'free',
        paymentMethods: ['cod'], codAdvanceEnabled: false, trustBadges: [],
      }).onConflictDoNothing();
      const [shop] = await tx.select().from(shops).where(eq(shops.id, shopId));
      if (shop?.ownerId !== ownerId || shop.handle !== 'daylight-demo') throw new Error('Demo identity conflict.');
      const colours = ['sage', 'oat', 'ink'];
      const image = (colour: string) => `/demo/tote/${colour}.svg`;
      const stock = [12, 5, 8, 0, 7, 0];
      const combinations: ProductVariantCombination[] = colours.flatMap((colour, ci) =>
        ['everyday', 'roomy'].map((size, si) => ({
          id: `${colour}-${size}`, optionIds: { colour, size },
          priceCents: si ? 109000 : 89000, stock: stock[ci * 2 + si],
          image: image(colour), sku: `DEMO-${colour.toUpperCase()}-${size.toUpperCase()}`,
          available: !(colour === 'ink' && size === 'roomy'),
        })),
      );
      await tx.insert(products).values({
        id: productId, shopId, name: 'Everyday Canvas Tote', slug: 'everyday-canvas-tote',
        cat: 'Bags & accessories', listingType: 'sale', priceCents: 89000, unit: 'bag',
        stock: stock.reduce((sum, n) => sum + n, 0), emoji: '👜', tone: '#e9ece3',
        deliveryDhakaCents: 7000, deliveryOutsideCents: 12000, paymentMethods: ['cod'],
        blurb: 'A little room for your everyday. A soft canvas tote with wide shoulder straps and an inside pocket for the small things.\n\nEveryday: 34 × 38 cm. Roomy: 40 × 44 cm. Choose Sage, Oat or Ink.\n\nLocal test product with illustrated images. Try changing colour and size to see the price, photo and stock update. Oat / Roomy is out of stock; Ink / Roomy is not offered.',
        images: colours.map(image),
        variantGroups: [
          { id: 'colour', name: 'Colour', options: colours.map((id) => ({ id, label: id[0].toUpperCase() + id.slice(1), priceDeltaCents: 0, image: image(id) })) },
          { id: 'size', name: 'Size', options: [{ id: 'everyday', label: 'Everyday', priceDeltaCents: 0 }, { id: 'roomy', label: 'Roomy', priceDeltaCents: 0 }] },
        ],
        variantCombinations: combinations,
      }).onConflictDoNothing();
    });
    console.log('Local variant product: http://localhost:5473/shop/daylight-demo/p/everyday-canvas-tote');
  } finally {
    await client.end();
  }
}
void main();
