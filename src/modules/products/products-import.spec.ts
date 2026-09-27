import { BadRequestException, ForbiddenException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { AdminPrincipal } from '../../common/types/principal';
import { ProductsImportService } from './products-import.service';
import type { ProductsService } from './products.service';
import {
  fetchImageAsDataUrl,
  isBlockedAddress,
  sniffImageMime,
} from './remote-image.util';

const owner = { kind: 'admin', role: 'owner' } as unknown as AdminPrincipal;
const staff = { kind: 'admin', role: 'staff' } as unknown as AdminPrincipal;

type Saved = { id: string; slug: string; name: string };
type Dto = Record<string, unknown>;
type CreateMock = jest.Mock<Promise<Saved>, [string, Dto]>;
type UpdateMock = jest.Mock<Promise<Saved>, [string, string, Dto]>;

function setup(
  existing: { id: string; slug: string; name: string }[] = [],
  overrides: { create?: CreateMock; update?: UpdateMock } = {},
) {
  let n = 0;
  const create =
    overrides.create ??
    jest.fn<Promise<Saved>, [string, Dto]>((_shop, dto) => {
      n += 1;
      return Promise.resolve({
        id: `new-${n}`,
        slug: `slug-${n}`,
        name: String(dto.name),
      });
    });
  const update =
    overrides.update ??
    jest.fn<Promise<Saved>, [string, string, Dto]>((_shop, id, dto) =>
      Promise.resolve({
        id,
        slug: `slug-of-${id}`,
        name: typeof dto.name === 'string' ? dto.name : '',
      }),
    );
  const db = {
    query: {
      products: {
        findMany: () =>
          Promise.resolve(
            existing.map((e) => ({ ...e, variantCombinations: [] })),
          ),
      },
    },
  };
  const config = { get: () => ({ publicPrefix: '/api/media' }) };
  const service = new ProductsImportService(
    db as never,
    { create, update } as unknown as ProductsService,
    config as unknown as ConfigService,
  );
  return { service, create, update };
}

describe('ProductsImportService', () => {
  it('returns one result per row, whatever the rows contain', async () => {
    const { service, create } = setup();
    const { results } = await service.importRows(
      's1',
      {
        rows: [
          null,
          'a string',
          [1, 2],
          { name: 'Mango box', price: 'abc' },
          { price: 10 },
          { name: 'Mango box', price: -5, stock: 1.5 },
          { name: 'Good one', price: 120, whoKnows: 'extra column' },
        ],
      },
      owner,
    );
    expect(results).toHaveLength(7);
    expect(results.slice(0, 3).map((r) => r.errors)).toEqual([
      ['This row could not be read.'],
      ['This row could not be read.'],
      ['This row could not be read.'],
    ]);
    expect(results[3]).toEqual({
      status: 'failed',
      errors: ['Price must be a number.'],
    });
    expect(results[4].errors).toEqual(['Name is missing.']);
    expect(results[5].errors).toEqual(
      expect.arrayContaining([
        'Price cannot be negative.',
        'Stock must be a whole number.',
      ]),
    );
    expect(results[6].status).toBe('created');
    // The unknown column never reached the product service.
    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0][1]).not.toHaveProperty('whoKnows');
  });

  it('requires a price for a new item, but not for a showcase one', async () => {
    const { service } = setup();
    const { results } = await service.importRows(
      's1',
      {
        rows: [
          { name: 'No price' },
          { name: 'Flat for rent', listingType: 'showcase' },
        ],
      },
      owner,
    );
    expect(results[0]).toEqual({
      status: 'failed',
      errors: ['Price is missing.'],
    });
    expect(results[1].status).toBe('created');
  });

  it('turns a thrown save into a message on that row only', async () => {
    const create = jest
      .fn<Promise<Saved>, [string, Dto]>()
      .mockRejectedValueOnce(
        new BadRequestException('Choices in “Size” need unique names and ids.'),
      )
      .mockRejectedValueOnce(new Error('connection reset'))
      .mockResolvedValueOnce({ id: 'p3', slug: 'three', name: 'Three' });
    const { service } = setup([], { create });
    const { results } = await service.importRows(
      's1',
      {
        rows: [
          { name: 'One', price: 1 },
          { name: 'Two', price: 2 },
          { name: 'Three', price: 3 },
        ],
      },
      owner,
    );
    expect(results.map((r) => r.status)).toEqual([
      'failed',
      'failed',
      'created',
    ]);
    expect(results[0].errors).toEqual([
      'Choices in “Size” need unique names and ids.',
    ]);
    // An unexpected error is logged, not leaked.
    expect(results[1].errors).toEqual([
      'This row could not be saved. Please try again.',
    ]);
  });

  it('shows a cancelled subscription as the row message', async () => {
    const create = jest
      .fn<Promise<Saved>, [string, Dto]>()
      .mockRejectedValue(
        new ForbiddenException(
          'Your subscription is cancelled - resume it to add new products.',
        ),
      );
    const { service } = setup([], { create });
    const { results } = await service.importRows(
      's1',
      { rows: [{ name: 'One', price: 1 }] },
      owner,
    );
    expect(results[0].errors).toEqual([
      'Your subscription is cancelled - resume it to add new products.',
    ]);
  });

  it('updates an item matched by link ID or name instead of duplicating it', async () => {
    const { service, create, update } = setup([
      { id: 'p1', slug: 'mango-box', name: 'Mango Box' },
    ]);
    const { results } = await service.importRows(
      's1',
      {
        rows: [
          { slug: 'mango-box', name: 'Mango Box (12)', price: 900 },
          { name: 'mango box (12)', stock: 4 },
          { name: 'New thing', price: 50 },
          { name: 'new thing', price: 60 },
        ],
      },
      owner,
    );
    expect(results.map((r) => r.status)).toEqual([
      'updated',
      'updated',
      'created',
      'updated',
    ]);
    expect(create).toHaveBeenCalledTimes(1);
    // A blank cell is not sent, so it can't wipe what the item already has.
    // Matched on the link ID: the new name is a rename.
    expect(update.mock.calls[0][2]).toMatchObject({ name: 'Mango Box (12)' });
    // Matched on the name: only capitals differ, so the name is left alone.
    expect(update.mock.calls[1][2]).toEqual({ stock: 4 });
  });

  it('leaves existing items alone in skip mode', async () => {
    const { service, update } = setup([
      { id: 'p1', slug: 'mango-box', name: 'Mango Box' },
    ]);
    const { results } = await service.importRows(
      's1',
      { rows: [{ name: 'Mango Box', price: 1 }], onExisting: 'skip' },
      owner,
    );
    expect(results[0].status).toBe('skipped');
    expect(update).not.toHaveBeenCalled();
  });

  it('refuses updates for an access level that can only add', async () => {
    const { service, update } = setup([
      { id: 'p1', slug: 'mango-box', name: 'Mango Box' },
    ]);
    const { results } = await service.importRows(
      's1',
      {
        rows: [
          { name: 'Mango Box', price: 1 },
          { name: 'Brand new', price: 1 },
        ],
      },
      staff,
    );
    expect(results.map((r) => r.status)).toEqual(['failed', 'created']);
    expect(update).not.toHaveBeenCalled();
  });

  it('keeps a row whose photo links fail, with a warning per photo', async () => {
    const { service, create } = setup();
    const { results } = await service.importRows(
      's1',
      {
        rows: [
          {
            name: 'With photos',
            price: 10,
            images: [
              '/api/media/products/abc.jpg',
              'http://127.0.0.1/secret.png',
              'ftp://example.com/a.png',
              'data:image/png;base64,AAAA',
            ],
          },
        ],
      },
      owner,
    );
    expect(results[0].status).toBe('created');
    expect(results[0].warnings).toHaveLength(3);
    expect(create.mock.calls[0][1].images).toEqual([
      '/api/media/products/abc.jpg',
    ]);
  });

  it('reads simple option groups for new items', async () => {
    const { service, create } = setup();
    await service.importRows(
      's1',
      {
        rows: [
          {
            name: 'Tee',
            price: 300,
            variants: [{ name: 'Size', options: ['S', 'M', 'L'] }],
          },
        ],
      },
      owner,
    );
    expect(create.mock.calls[0][1].variantGroups).toEqual([
      {
        name: 'Size',
        options: [{ label: 'S' }, { label: 'M' }, { label: 'L' }],
      },
    ]);
  });
});

describe('remote image guard', () => {
  it('blocks private, loopback and link-local addresses', () => {
    for (const ip of [
      '127.0.0.1',
      '10.1.2.3',
      '172.20.0.1',
      '192.168.1.1',
      '169.254.169.254',
      '0.0.0.0',
      '::1',
      'fd00::1',
      '::ffff:10.0.0.1',
    ]) {
      expect(isBlockedAddress(ip)).toBe(true);
    }
    expect(isBlockedAddress('8.8.8.8')).toBe(false);
    expect(isBlockedAddress('2606:4700::1111')).toBe(false);
  });

  it('refuses bad links before any request is made', async () => {
    await expect(fetchImageAsDataUrl('not a url')).rejects.toThrow(
      'not a valid web address',
    );
    await expect(fetchImageAsDataUrl('file:///etc/passwd')).rejects.toThrow(
      'Only http',
    );
    await expect(
      fetchImageAsDataUrl('http://169.254.169.254/latest/meta-data'),
    ).rejects.toThrow('not allowed');
    await expect(
      fetchImageAsDataUrl('http://example.com:22/x.png'),
    ).rejects.toThrow('not allowed');
  });

  it('recognises raster images by their bytes, and nothing else', () => {
    expect(sniffImageMime(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe(
      'image/jpeg',
    );
    expect(
      sniffImageMime(
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]),
      ),
    ).toBe('image/png');
    expect(sniffImageMime(Buffer.from('<svg xmlns="..."></svg>'))).toBeNull();
    expect(sniffImageMime(Buffer.from('<html></html>'))).toBeNull();
  });
});
