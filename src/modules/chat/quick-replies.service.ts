import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { and, asc, eq } from 'drizzle-orm';
import { DRIZZLE } from '../../database/database.constants';
import type { DrizzleDB } from '../../database/drizzle.types';
import {
  chatQuickReplies,
  type ChatQuickReplyRow,
} from '../../database/schema';
import type { SellerActor } from './chat-actor';
import type { QuickReplyDto, ReorderQuickRepliesDto } from './dto/chat.dto';

/** `@IsNotEmpty()` lets whitespace-only strings through; reject post-trim. */
function requireText(dto: QuickReplyDto): string {
  const text = dto.text.trim();
  if (!text) throw new BadRequestException('Quick reply text is required');
  return text;
}

/** Starter set seeded the first time a shop opens its inbox. Sellers can
    remove these (is_default rows are hidden, not deleted, so the seed marker
    survives) but not edit them; they manage their own on top. */
const DEFAULT_QUICK_REPLIES = [
  'Thanks for reaching out! 🙌',
  'Yes, that’s in stock right now.',
  'Let me check and get back to you shortly.',
];

@Injectable()
export class QuickRepliesService {
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDB) {}

  /** List the shop's canned responses, seeding the defaults on first use. */
  async list(actor: SellerActor): Promise<ChatQuickReplyRow[]> {
    // Hidden rows (removed defaults) still count as "already seeded".
    const existing = await this.db.query.chatQuickReplies.findMany({
      where: eq(chatQuickReplies.shopId, actor.shopId),
      orderBy: [
        asc(chatQuickReplies.sortOrder),
        asc(chatQuickReplies.createdAt),
      ],
    });
    if (existing.length > 0) return existing.filter((row) => !row.hidden);
    return this.db
      .insert(chatQuickReplies)
      .values(
        DEFAULT_QUICK_REPLIES.map((text, sortOrder) => ({
          shopId: actor.shopId,
          text,
          sortOrder,
          isDefault: true,
        })),
      )
      .returning();
  }

  async create(
    actor: SellerActor,
    dto: QuickReplyDto,
  ): Promise<ChatQuickReplyRow> {
    const [row] = await this.db
      .insert(chatQuickReplies)
      .values({
        shopId: actor.shopId,
        text: requireText(dto),
        sortOrder: dto.sortOrder ?? 0,
      })
      .returning();
    return row;
  }

  async update(
    actor: SellerActor,
    id: string,
    dto: QuickReplyDto,
  ): Promise<ChatQuickReplyRow> {
    await this.assertNotDefault(actor, id);
    const [row] = await this.db
      .update(chatQuickReplies)
      .set({
        text: requireText(dto),
        ...(dto.sortOrder !== undefined ? { sortOrder: dto.sortOrder } : {}),
      })
      .where(
        and(
          eq(chatQuickReplies.id, id),
          eq(chatQuickReplies.shopId, actor.shopId),
        ),
      )
      .returning();
    if (!row) throw new NotFoundException('Quick reply not found');
    return row;
  }

  /** Persist a manual ordering: every visible reply id, in display order. */
  async reorder(
    actor: SellerActor,
    dto: ReorderQuickRepliesDto,
  ): Promise<ChatQuickReplyRow[]> {
    const visible = await this.db.query.chatQuickReplies.findMany({
      where: and(
        eq(chatQuickReplies.shopId, actor.shopId),
        eq(chatQuickReplies.hidden, false),
      ),
      columns: { id: true },
    });
    const visibleIds = new Set(visible.map((row) => row.id));
    const requested = new Set(dto.ids);
    if (
      requested.size !== dto.ids.length ||
      requested.size !== visibleIds.size ||
      dto.ids.some((id) => !visibleIds.has(id))
    )
      throw new BadRequestException(
        'ids must contain each of the shop’s quick replies exactly once',
      );
    await this.db.transaction(async (tx) => {
      for (const [sortOrder, id] of dto.ids.entries()) {
        await tx
          .update(chatQuickReplies)
          .set({ sortOrder })
          .where(eq(chatQuickReplies.id, id));
      }
    });
    return this.list(actor);
  }

  async remove(actor: SellerActor, id: string): Promise<void> {
    const scope = and(
      eq(chatQuickReplies.id, id),
      eq(chatQuickReplies.shopId, actor.shopId),
    );
    const row = await this.db.query.chatQuickReplies.findFirst({
      where: scope,
      columns: { isDefault: true, hidden: true },
    });
    if (!row || row.hidden)
      throw new NotFoundException('Quick reply not found');
    // Defaults double as the seed marker for list(); hide them instead of
    // deleting so an emptied shop isn't re-seeded on the next inbox load.
    if (row.isDefault) {
      await this.db
        .update(chatQuickReplies)
        .set({ hidden: true })
        .where(scope);
    } else {
      await this.db.delete(chatQuickReplies).where(scope);
    }
  }

  /** Default texts are platform-managed: 404 if missing, 403 if locked. */
  private async assertNotDefault(
    actor: SellerActor,
    id: string,
  ): Promise<void> {
    const row = await this.db.query.chatQuickReplies.findFirst({
      where: and(
        eq(chatQuickReplies.id, id),
        eq(chatQuickReplies.shopId, actor.shopId),
      ),
      columns: { isDefault: true, hidden: true },
    });
    if (!row || row.hidden)
      throw new NotFoundException('Quick reply not found');
    if (row.isDefault)
      throw new ForbiddenException('Default quick replies cannot be edited');
  }
}
