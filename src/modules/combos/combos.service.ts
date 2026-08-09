import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { dollarsToCents } from '../../common/utils/money.util';
import { DRIZZLE } from '../../database/database.constants';
import type { DrizzleDB } from '../../database/drizzle.types';
import {
  comboItems,
  combos,
  products,
  type ComboItemRow,
  type ComboRow,
  type ProductRow,
} from '../../database/schema';
import { ShopsService } from '../shops/shops.service';
import { ComboResponse } from './dto/combo.response';
import type {
  ComboItemDto,
  CreateComboDto,
  UpdateComboDto,
} from './dto/create-combo.dto';

type ComboWithProducts = ComboRow & {
  items: (ComboItemRow & { product: ProductRow })[];
};

@Injectable()
export class CombosService {
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDB,
    private readonly shops: ShopsService,
  ) {}

  /** Admin list - every combo of the shop, newest first. */
  async listForShop(shopId: string): Promise<ComboResponse[]> {
    const rows = (await this.db.query.combos.findMany({
      where: eq(combos.shopId, shopId),
      orderBy: [desc(combos.createdAt)],
      with: { items: { with: { product: true } } },
    })) as ComboWithProducts[];
    return rows.map((c) => ComboResponse.fromRows(c, c.items));
  }

  /**
   * Buyer-facing combos: active, still ≥ 2 members, every member orderable
   * online (sale listing) with enough stock for at least one set.
   */
  async publicForShop(shopId: string): Promise<ComboResponse[]> {
    const rows = (await this.db.query.combos.findMany({
      where: and(eq(combos.shopId, shopId), eq(combos.active, true)),
      orderBy: [desc(combos.createdAt)],
      with: { items: { with: { product: true } } },
    })) as ComboWithProducts[];
    return rows
      .filter(
        (c) =>
          c.items.length >= 2 &&
          c.items.every(
            (i) =>
              i.product.listingType === 'sale' &&
              !(i.product.variantCombinations ?? []).length &&
              i.product.stock >= i.qty,
          ),
      )
      .map((c) => ComboResponse.fromRows(c, c.items));
  }

  /** Buyer-facing combos that include a given product. */
  async publicForProduct(
    shopId: string,
    productId: string,
  ): Promise<ComboResponse[]> {
    const all = await this.publicForShop(shopId);
    return all.filter((c) => c.items.some((i) => i.productId === productId));
  }

  async create(shopId: string, dto: CreateComboDto): Promise<ComboResponse> {
    await this.shops.requireById(shopId);
    const members = this.normalizeMembers(dto.items);
    await this.requireSaleProducts(shopId, members);
    const created = await this.db.transaction(async (tx) => {
      const [combo] = await tx
        .insert(combos)
        .values({
          shopId,
          name: dto.name,
          blurb: dto.blurb ?? '',
          emoji: dto.emoji ?? '🎁',
          priceCents: dollarsToCents(dto.price),
          active: dto.active ?? true,
        })
        .returning();
      await tx.insert(comboItems).values(
        members.map((m) => ({
          comboId: combo.id,
          productId: m.productId,
          qty: m.qty,
        })),
      );
      return combo;
    });
    return this.requireResponse(shopId, created.id);
  }

  async update(
    shopId: string,
    id: string,
    dto: UpdateComboDto,
  ): Promise<ComboResponse> {
    await this.requireOwned(shopId, id);
    const members = dto.items ? this.normalizeMembers(dto.items) : undefined;
    if (members) {
      await this.requireSaleProducts(shopId, members);
    }
    await this.db.transaction(async (tx) => {
      await tx
        .update(combos)
        .set({
          name: dto.name ?? undefined,
          blurb: dto.blurb ?? undefined,
          emoji: dto.emoji ?? undefined,
          priceCents:
            dto.price !== undefined ? dollarsToCents(dto.price) : undefined,
          active: dto.active ?? undefined,
        })
        .where(eq(combos.id, id));
      // Present `items` replaces the member list wholesale.
      if (members) {
        await tx.delete(comboItems).where(eq(comboItems.comboId, id));
        await tx.insert(comboItems).values(
          members.map((m) => ({
            comboId: id,
            productId: m.productId,
            qty: m.qty,
          })),
        );
      }
    });
    return this.requireResponse(shopId, id);
  }

  async remove(shopId: string, id: string): Promise<{ ok: true }> {
    await this.requireOwned(shopId, id);
    await this.db.delete(combos).where(eq(combos.id, id));
    return { ok: true };
  }

  /** Collapse duplicate products into one row, summing quantities. */
  private normalizeMembers(
    items: ComboItemDto[],
  ): { productId: string; qty: number }[] {
    const byProduct = new Map<string, number>();
    for (const item of items) {
      byProduct.set(
        item.productId,
        (byProduct.get(item.productId) ?? 0) + (item.qty ?? 1),
      );
    }
    const members = [...byProduct.entries()].map(([productId, qty]) => ({
      productId,
      qty,
    }));
    if (members.length < 2) {
      throw new BadRequestException(
        'A combo needs at least 2 different products',
      );
    }
    return members;
  }

  /** Every member must be a sale-listed product of this shop. */
  private async requireSaleProducts(
    shopId: string,
    members: { productId: string }[],
  ): Promise<void> {
    const rows = await this.db.query.products.findMany({
      where: and(
        eq(products.shopId, shopId),
        inArray(
          products.id,
          members.map((m) => m.productId),
        ),
      ),
      columns: { id: true, listingType: true, variantCombinations: true },
    });
    const found = new Map(rows.map((r) => [r.id, r]));
    for (const m of members) {
      const row = found.get(m.productId);
      if (!row) {
        throw new BadRequestException(
          'One of the combo products no longer exists in this shop',
        );
      }
      if (row.listingType !== 'sale') {
        throw new BadRequestException(
          'Showcase items cannot be part of a combo - only items sold online',
        );
      }
      if ((row.variantCombinations ?? []).length) {
        throw new BadRequestException(
          'Products with buyer-selectable variants cannot be added to a combo yet.',
        );
      }
    }
  }

  private async requireOwned(shopId: string, id: string): Promise<ComboRow> {
    const combo = await this.db.query.combos.findFirst({
      where: and(eq(combos.id, id), eq(combos.shopId, shopId)),
    });
    if (!combo) {
      throw new NotFoundException('Combo not found in this shop');
    }
    return combo;
  }

  private async requireResponse(
    shopId: string,
    id: string,
  ): Promise<ComboResponse> {
    const row = await this.db.query.combos.findFirst({
      where: and(eq(combos.id, id), eq(combos.shopId, shopId)),
      with: { items: { with: { product: true } } },
    });
    if (!row) {
      throw new NotFoundException('Combo not found in this shop');
    }
    return ComboResponse.fromRows(row, row.items);
  }
}
