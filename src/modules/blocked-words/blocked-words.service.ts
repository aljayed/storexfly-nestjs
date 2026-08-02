import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  type OnModuleInit,
} from '@nestjs/common';
import { asc, eq } from 'drizzle-orm';
import { isUniqueViolation } from '../../common/utils/postgres-error.util';
import { DRIZZLE } from '../../database/database.constants';
import type { DrizzleDB } from '../../database/drizzle.types';
import { blockedWords, type BlockedWordRow } from '../../database/schema';

/**
 * Seeded on boot so a fresh database still rejects the obvious cases -
 * common profanity, plus terms that would let a shop or account impersonate
 * the platform itself. Operators can add to or remove from this list from
 * the platform-admin console; this is only the starting point.
 */
const DEFAULT_BLOCKED_WORDS = [
  // Brand / impersonation protection.
  'hoomri',
  'admin',
  'administrator',
  'official',
  'moderator',
  'support',
  'staff',
  // Common profanity.
  'fuck',
  'shit',
  'bitch',
  'asshole',
  'bastard',
  'cunt',
  'dick',
  'pussy',
  'nigger',
  'faggot',
  'whore',
  'slut',
  'cock',
  'motherfucker',
  'rape',
];

@Injectable()
export class BlockedWordsService implements OnModuleInit {
  private readonly logger = new Logger(BlockedWordsService.name);

  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDB) {}

  async onModuleInit(): Promise<void> {
    try {
      const inserted = await this.db
        .insert(blockedWords)
        .values(DEFAULT_BLOCKED_WORDS.map((word) => ({ word })))
        .onConflictDoNothing({ target: blockedWords.word })
        .returning({ id: blockedWords.id });
      if (inserted.length > 0) {
        this.logger.log(`Seeded ${inserted.length} default blocked words`);
      }
    } catch (err) {
      this.logger.error('Failed to seed default blocked words', err as Error);
    }
  }

  // ── Platform-admin CRUD ────────────────────────────────────────

  async list(): Promise<BlockedWordRow[]> {
    return this.db.query.blockedWords.findMany({
      orderBy: [asc(blockedWords.word)],
    });
  }

  async add(word: string): Promise<BlockedWordRow> {
    const normalized = word.trim().toLowerCase();
    try {
      const [row] = await this.db
        .insert(blockedWords)
        .values({ word: normalized })
        .returning();
      return row;
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new ConflictException('That word is already blocked');
      }
      throw err;
    }
  }

  async remove(id: string): Promise<void> {
    const [row] = await this.db
      .delete(blockedWords)
      .where(eq(blockedWords.id, id))
      .returning({ id: blockedWords.id });
    if (!row) throw new NotFoundException('Blocked word not found');
  }

  // ── Enforcement ────────────────────────────────────────────────

  /**
   * Throws if `text` contains any blocked word as a case-insensitive
   * substring. Call before writing a shop name/handle or a seller/buyer
   * display name.
   */
  async assertClean(text: string): Promise<void> {
    const haystack = text.toLowerCase();
    const rows = await this.list();
    const hit = rows.find((row) => haystack.includes(row.word));
    if (hit) {
      throw new BadRequestException(
        `"${text}" isn't allowed - it contains a blocked word.`,
      );
    }
  }
}
