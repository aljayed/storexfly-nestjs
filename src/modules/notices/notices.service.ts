import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, desc, eq, isNull, or } from 'drizzle-orm';
import { DRIZZLE } from '../../database/database.constants';
import type { DrizzleDB } from '../../database/drizzle.types';
import { notices } from '../../database/schema';
import type { NoticeRow, NoticeTone } from '../../database/schema';
import { ShopsService } from '../shops/shops.service';
import type { NoticeResponse } from './dto/notice.dto';

/**
 * Platform-to-seller announcements. The operator writes them (global or
 * targeted at one shop); seller consoles read their active set on every
 * load, so publishing/deactivating takes effect immediately.
 */
@Injectable()
export class NoticesService {
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDB,
    private readonly shops: ShopsService,
  ) {}

  /** Platform admin: every notice, newest first, with the target shop name. */
  async listAll(): Promise<{ data: NoticeResponse[] }> {
    const rows = await this.db.query.notices.findMany({
      orderBy: [desc(notices.createdAt)],
      with: { shop: { columns: { name: true } } },
    });
    return {
      data: rows.map((n) => toResponse(n, n.shop?.name ?? undefined)),
    };
  }

  /** Seller console: active banners for one shop (broadcasts + targeted). */
  async listForShop(shopId: string): Promise<{ data: NoticeResponse[] }> {
    await this.shops.requireById(shopId);
    const rows = await this.db.query.notices.findMany({
      where: and(
        eq(notices.active, true),
        or(isNull(notices.shopId), eq(notices.shopId, shopId)),
      ),
      orderBy: [desc(notices.createdAt)],
    });
    return { data: rows.map((n) => toResponse(n)) };
  }

  async create(
    message: string,
    tone: NoticeTone = 'info',
    shopId?: string,
  ): Promise<NoticeResponse> {
    let shopName: string | undefined;
    if (shopId) {
      shopName = (await this.shops.requireById(shopId)).name;
    }
    const [row] = await this.db
      .insert(notices)
      .values({ message: message.trim(), tone, shopId: shopId ?? null })
      .returning();
    return toResponse(row, shopName);
  }

  async update(
    id: string,
    patch: { message?: string; tone?: NoticeTone; active?: boolean },
  ): Promise<NoticeResponse> {
    const [row] = await this.db
      .update(notices)
      .set({
        ...(patch.message !== undefined && { message: patch.message.trim() }),
        ...(patch.tone !== undefined && { tone: patch.tone }),
        ...(patch.active !== undefined && { active: patch.active }),
      })
      .where(eq(notices.id, id))
      .returning();
    if (!row) throw new NotFoundException('Notice not found');
    const shopName = row.shopId
      ? (await this.shops.requireById(row.shopId)).name
      : undefined;
    return toResponse(row, shopName);
  }

  async remove(id: string): Promise<void> {
    const deleted = await this.db
      .delete(notices)
      .where(eq(notices.id, id))
      .returning({ id: notices.id });
    if (!deleted.length) throw new NotFoundException('Notice not found');
  }
}

function toResponse(row: NoticeRow, shopName?: string): NoticeResponse {
  return {
    id: row.id,
    shopId: row.shopId ?? undefined,
    shopName,
    message: row.message,
    tone: row.tone,
    active: row.active,
    createdAt: row.createdAt.toISOString(),
  };
}
