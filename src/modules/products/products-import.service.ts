import { HttpException, Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { plainToInstance } from 'class-transformer';
import { validate, type ValidationError } from 'class-validator';
import { eq } from 'drizzle-orm';
import { roleHasPermission } from '../../common/auth/admin-permissions';
import type { AdminPrincipal } from '../../common/types/principal';
import { DRIZZLE } from '../../database/database.constants';
import type { DrizzleDB } from '../../database/drizzle.types';
import { products } from '../../database/schema';
import type { CreateProductDto } from './dto/create-product.dto';
import {
  ImportRowDto,
  isPlainRow,
  type ImportProductsDto,
  type ImportProductsResponse,
  type ImportRowResult,
} from './dto/import-products.dto';
import { ProductsService } from './products.service';
import { fetchImageAsDataUrl, RemoteImageError } from './remote-image.util';

/** What an import needs to know about an item already in the shop. */
interface Existing {
  id: string;
  slug: string;
  name: string;
  hasExactVariants: boolean;
}

/** Remote photos fetched at once across a request's rows. */
const IMAGE_CONCURRENCY = 6;

/**
 * Bulk import for the console's Products page.
 *
 * The browser reads the seller's CSV/XLSX, maps its columns, and sends typed
 * rows here a few at a time. The one promise this service makes is that a
 * row can only ever fail *itself*: every row is validated, matched and saved
 * on its own, any exception is caught and turned into a message on that row,
 * and the response always has exactly one result per row sent.
 *
 * Rows are saved through {@link ProductsService} - the same code the item form
 * uses - so an imported item can't end up in a shape the form couldn't make.
 */
@Injectable()
export class ProductsImportService {
  private readonly logger = new Logger(ProductsImportService.name);
  private readonly mediaPrefix: string;

  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDB,
    private readonly productsService: ProductsService,
    config: ConfigService,
  ) {
    this.mediaPrefix =
      config.get<{ publicPrefix?: string }>('storage')?.publicPrefix ??
      '/api/media';
  }

  async importRows(
    shopId: string,
    dto: ImportProductsDto,
    admin: AdminPrincipal,
  ): Promise<ImportProductsResponse> {
    const onExisting = dto.onExisting ?? 'update';
    const canAdd = roleHasPermission(admin.role, 'items.add');
    const canEdit = roleHasPermission(admin.role, 'items.edit');

    const rows = await this.db.query.products.findMany({
      where: eq(products.shopId, shopId),
      columns: { id: true, slug: true, name: true, variantCombinations: true },
    });
    const bySlug = new Map<string, Existing>();
    const byName = new Map<string, Existing>();
    const remember = (e: Existing) => {
      bySlug.set(e.slug, e);
      byName.set(nameKey(e.name), e);
    };
    rows.forEach((r) =>
      remember({
        id: r.id,
        slug: r.slug,
        name: r.name,
        hasExactVariants: (r.variantCombinations ?? []).length > 0,
      }),
    );

    // Validate everything first, so photos are only downloaded for rows that
    // can actually be saved.
    const checked = await Promise.all(dto.rows.map((raw) => this.check(raw)));
    const photos = await this.resolveAllImages(
      checked.map((c) => ('row' in c ? (c.row.images ?? []) : [])),
    );

    // Saves run one after another: two rows with the same name in one file
    // must see each other (the second becomes an update, not a duplicate),
    // and slugs are allocated by read-then-insert.
    const results: ImportRowResult[] = [];
    for (let i = 0; i < checked.length; i++) {
      const c = checked[i];
      if ('errors' in c) {
        results.push({ status: 'failed', errors: c.errors });
        continue;
      }
      try {
        results.push(
          await this.saveRow(c.row, photos[i], {
            shopId,
            onExisting,
            canAdd,
            canEdit,
            bySlug,
            byName,
            remember,
          }),
        );
      } catch (err) {
        results.push({ status: 'failed', errors: [this.messageOf(err)] });
      }
    }
    return { results };
  }

  /** Validate one loose row. Never throws. */
  private async check(
    raw: unknown,
  ): Promise<{ row: ImportRowDto } | { errors: string[] }> {
    if (!isPlainRow(raw)) {
      return { errors: ['This row could not be read.'] };
    }
    try {
      const row = plainToInstance(ImportRowDto, raw, {
        enableImplicitConversion: false,
      });
      // Unknown keys are dropped rather than rejected: a column the seller
      // mapped to something we don't store is not their mistake.
      const errors = await validate(row, {
        whitelist: true,
        forbidNonWhitelisted: false,
      });
      if (errors.length) return { errors: flatten(errors) };
      if (typeof row.name === 'string') row.name = row.name.trim();
      return { row };
    } catch (err) {
      this.logger.warn(
        `Import row failed validation unexpectedly: ${String(err)}`,
      );
      return { errors: ['This row could not be read.'] };
    }
  }

  private async saveRow(
    row: ImportRowDto,
    photos: { images: string[]; warnings: string[] },
    ctx: {
      shopId: string;
      onExisting: 'update' | 'skip';
      canAdd: boolean;
      canEdit: boolean;
      bySlug: Map<string, Existing>;
      byName: Map<string, Existing>;
      remember: (e: Existing) => void;
    },
  ): Promise<ImportRowResult> {
    const warnings = [...photos.warnings];
    const slug = row.slug?.trim();
    const bySlug = slug ? ctx.bySlug.get(slug) : undefined;
    const match = bySlug ?? ctx.byName.get(nameKey(row.name));
    if (slug && !match) {
      warnings.push(
        `No item has the link ID "${slug}" any more, so this row was added as a new item.`,
      );
    }

    if (match) {
      if (ctx.onExisting === 'skip') {
        return {
          status: 'skipped',
          id: match.id,
          slug: match.slug,
          warnings: [
            'This item is already in your shop, so it was left as it is.',
          ],
        };
      }
      if (!ctx.canEdit) {
        return {
          status: 'failed',
          errors: [
            'This item is already in your shop, and your access level can add items but not change them.',
          ],
        };
      }
      if (row.variants?.length) {
        warnings.push(
          'Options are only read for new items. Change the options of an existing item on its edit page.',
        );
      }
      if (
        match.hasExactVariants &&
        (row.price !== undefined || row.stock !== undefined)
      ) {
        warnings.push(
          'This item has per-option prices and stock, so its price and stock were left unchanged. Edit them on the item page.',
        );
      }
      const patch: Partial<CreateProductDto> = this.fields(row);
      // Matched on the name, the name already is this one - rewriting it
      // would only change its capitals. Matched on the link ID, a different
      // name in the file is a deliberate rename.
      if (!bySlug) delete patch.name;
      // A row that names photos but none of them could be fetched must not
      // wipe the photos the item already has.
      if (row.images?.length) {
        if (photos.images.length) patch.images = photos.images;
        else
          warnings.push(
            'None of the photo links worked, so the existing photos were kept.',
          );
      }
      const saved = await this.productsService.update(
        ctx.shopId,
        match.id,
        patch,
      );
      if (saved.name !== match.name) {
        ctx.byName.delete(nameKey(match.name));
      }
      ctx.remember({ ...match, name: saved.name });
      return result('updated', saved, warnings);
    }

    if (!ctx.canAdd) {
      return {
        status: 'failed',
        errors: ['Your access level does not allow adding items.'],
      };
    }
    const listingType = row.listingType ?? 'sale';
    if (row.price === undefined && listingType !== 'showcase') {
      return { status: 'failed', errors: ['Price is missing.'] };
    }
    const create: CreateProductDto = {
      unit: '',
      cat: 'Other',
      ...this.fields(row),
      name: row.name,
      price: row.price ?? 0,
      images: photos.images.length ? photos.images : undefined,
      variantGroups: row.variants?.map((g) => ({
        name: g.name.trim(),
        options: g.options.map((label) => ({ label: label.trim() })),
      })),
    };
    const saved = await this.productsService.create(ctx.shopId, create);
    ctx.remember({
      id: saved.id,
      slug: saved.slug,
      name: saved.name,
      hasExactVariants: false,
    });
    return result('created', saved, warnings);
  }

  /** The plain fields a row carries; absent cells stay absent (= unchanged). */
  private fields(row: ImportRowDto): Partial<CreateProductDto> {
    const out: Partial<CreateProductDto> = {
      name: row.name,
      cat: row.cat?.trim() || undefined,
      listingType: row.listingType,
      price: row.price,
      comparePrice: row.comparePrice,
      unit: row.unit?.trim(),
      stock: row.stock,
      tag: row.tag,
      blurb: row.blurb,
      deliveryDhaka: row.deliveryDhaka,
      deliveryOutside: row.deliveryOutside,
      emoji: row.emoji?.trim() || undefined,
      videoUrl: row.videoUrl,
    };
    // A regular price at or below the selling price is not a discount; the
    // storefront would hide it anyway, so don't store a misleading number.
    if (
      out.comparePrice !== undefined &&
      out.price !== undefined &&
      out.comparePrice <= out.price
    ) {
      out.comparePrice = 0;
    }
    return Object.fromEntries(
      Object.entries(out).filter(([, v]) => v !== undefined),
    );
  }

  /**
   * Turn every row's photo links into storable values, a few downloads at a
   * time across the whole request. Our own `/api/media/...` links (what an
   * export writes) pass straight through; anything else is downloaded. A
   * link that fails becomes a warning on its row, never an error.
   */
  private async resolveAllImages(
    perRow: string[][],
  ): Promise<{ images: string[]; warnings: string[] }[]> {
    const out = perRow.map(() => ({
      images: [] as (string | null)[],
      warnings: [] as string[],
    }));
    const jobs: { row: number; at: number; url: string }[] = [];
    perRow.forEach((urls, row) => {
      out[row].images = urls.map(() => null);
      urls.forEach((url, at) => jobs.push({ row, at, url: url.trim() }));
    });

    let next = 0;
    const worker = async () => {
      while (next < jobs.length) {
        const job = jobs[next++];
        const n = job.at + 1;
        try {
          out[job.row].images[job.at] = await this.resolveImage(job.url);
        } catch (err) {
          const why =
            err instanceof RemoteImageError
              ? err.message
              : 'The image could not be downloaded.';
          out[job.row].warnings.push(`Photo ${n} was skipped: ${why}`);
          if (!(err instanceof RemoteImageError)) {
            this.logger.warn(`Import photo failed: ${String(err)}`);
          }
        }
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(IMAGE_CONCURRENCY, jobs.length) }, worker),
    );
    return out.map((o) => ({
      images: o.images.filter((v): v is string => !!v),
      warnings: o.warnings,
    }));
  }

  private async resolveImage(url: string): Promise<string> {
    if (!url) throw new RemoteImageError('The link is empty.');
    if (url.startsWith(`${this.mediaPrefix}/`)) return url;
    if (url.startsWith('data:')) {
      throw new RemoteImageError(
        'Pasted image data is not supported, use a link.',
      );
    }
    const dataUrl = await fetchImageAsDataUrl(url);
    // ProductsService.create/update absorbs data URLs into storage.
    return dataUrl;
  }

  /** A readable reason for anything thrown while saving a row. */
  private messageOf(err: unknown): string {
    if (err instanceof HttpException) {
      const body = err.getResponse();
      const message =
        typeof body === 'string'
          ? body
          : (body as { message?: string | string[] }).message;
      if (Array.isArray(message)) return message.join(' ');
      if (message) return message;
    }
    this.logger.error(
      `Import row failed to save: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`,
    );
    return 'This row could not be saved. Please try again.';
  }
}

const nameKey = (name: string) => name.trim().toLocaleLowerCase();

function result(
  status: 'created' | 'updated',
  saved: { id: string; slug: string },
  warnings: string[],
): ImportRowResult {
  return {
    status,
    id: saved.id,
    slug: saved.slug,
    warnings: warnings.length ? warnings : undefined,
  };
}

const TYPE_CHECKS = new Set([
  'isString',
  'isNumber',
  'isInt',
  'isArray',
  'isIn',
  'nestedValidation',
]);

/** Every constraint message in a (possibly nested) validation error tree. */
function flatten(errors: ValidationError[]): string[] {
  const out: string[] = [];
  const walk = (list: ValidationError[]) => {
    for (const e of list) {
      if (e.constraints) {
        // One message per field is enough - "Price must be a number" makes
        // "Price cannot be negative" redundant - and the type check is the
        // one that explains the others, so it wins.
        const entries = Object.entries(e.constraints);
        const first = (entries.find(([k]) => TYPE_CHECKS.has(k)) ??
          entries[0])?.[1];
        if (first && !out.includes(first)) out.push(first);
      }
      if (e.children?.length) walk(e.children);
    }
  };
  walk(errors);
  return out.length ? out : ['This row has an invalid value.'];
}
