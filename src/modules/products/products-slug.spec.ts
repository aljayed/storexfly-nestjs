import { ProductsService } from './products.service';

/** A shop where the first `clashes` candidate slugs are already taken. */
function slugFor(name: string, clashes = 0) {
  let seen = 0;
  const db = {
    query: {
      products: {
        findFirst: jest.fn(() =>
          Promise.resolve(seen++ < clashes ? { id: 'x' } : null),
        ),
      },
    },
  };
  const service = new ProductsService(
    db as never,
    null as never,
    null as never,
    null as never,
  );
  return (
    service as unknown as {
      uniqueSlug(shop: string, name: string, id: string): Promise<string>;
    }
  ).uniqueSlug('shop', name, '3f9a2c1d-7b44-4e0a-9c1e-5a6b7c8d9e0f');
}

describe('product slugs', () => {
  it('builds one from a Latin name', async () => {
    expect(await slugFor('Silk Saree 2026')).toBe('silk-saree-2026');
  });

  it("takes the product id's first 8 characters for a Bangla-only name", async () => {
    expect(await slugFor('বাটিক থ্রী পিস')).toBe('3f9a2c1d');
  });

  it('keeps the Latin part of a mixed name', async () => {
    expect(await slugFor('Premium শাড়ি')).toBe('premium');
  });

  it('still numbers a clash', async () => {
    expect(await slugFor('Silk Saree', 1)).toBe('silk-saree-2');
  });
});
