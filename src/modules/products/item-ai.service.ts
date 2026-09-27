import {
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { DRIZZLE } from '../../database/database.constants';
import type { DrizzleDB } from '../../database/drizzle.types';
import { shops } from '../../database/schema';
import { ItemAiCardCopyDto, ItemAiTurnDto } from './dto/item-ai.dto';

interface AgentTurn {
  reply?: string;
  draft?: Record<string, unknown>;
  flow?: Record<string, unknown>;
  step?: string;
  quick_replies?: { label: string; value: string }[];
  missing?: string[];
  rejected?: Record<string, string>;
  ai_used?: boolean;
}

/**
 * The seller console's "add with AI" assistant, reached through here.
 *
 * The assistant runs in the separate FastAPI chat service. The browser never
 * talks to it directly for this: its public `/ai/` prefix has no seller
 * authentication, so this layer is what checks the console session and the
 * `items.add` permission, fills in the shop from the authenticated scope rather
 * than trusting a posted id, and signs the call with the shared key the
 * service requires.
 *
 * It only ever returns a draft. The product is created afterwards through the
 * normal product API, with every rule that API enforces.
 */
/**
 * Shorten to at most `max` characters without breaking a word - or, in a
 * script like Bangla, a letter: a raw slice can cut a vowel sign off its
 * consonant. Falls back to whole grapheme clusters for one long word.
 */
export function clipWords(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max + 1);
  const space = cut.search(/\s\S*$/);
  if (space > max / 2) return cut.slice(0, space).trim();
  let out = '';
  for (const { segment } of new Intl.Segmenter(undefined, {
    granularity: 'grapheme',
  }).segment(text)) {
    if (out.length + segment.length > max) break;
    out += segment;
  }
  return out.trim();
}

@Injectable()
export class ItemAiService {
  private readonly log = new Logger(ItemAiService.name);

  /** Same-network address of the chat service - shared with the inbox bot. */
  private readonly agentUrl = (
    process.env.CHAT_AGENT_URL ?? 'http://chat:8000'
  ).replace(/\/+$/, '');

  /** Must equal INTERNAL_API_KEY in the chat service. Empty = feature off. */
  private readonly agentKey = process.env.CHAT_AGENT_KEY ?? '';

  private readonly timeoutMs = Number(
    process.env.CHAT_AGENT_TIMEOUT_MS ?? 45_000,
  );

  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDB) {}

  async turn(shopId: string, dto: ItemAiTurnDto) {
    const shop = await this.shopContext(shopId, dto.locale);
    const body = await this.post<AgentTurn>('/api/v1/items/draft/turn', {
      shop,
      draft: dto.draft ?? {},
      flow: dto.flow ?? {},
      history: dto.history ?? [],
      event: dto.event,
      image_hint: dto.imageHint,
    });
    return {
      reply: body.reply ?? '',
      draft: body.draft ?? {},
      flow: body.flow ?? {},
      step: body.step ?? 'name',
      quickReplies: body.quick_replies ?? [],
      missing: body.missing ?? [],
      rejected: body.rejected ?? {},
      aiUsed: Boolean(body.ai_used),
    };
  }

  async cardCopy(shopId: string, dto: ItemAiCardCopyDto) {
    const shop = await this.shopContext(shopId, dto.locale);
    const body = await this.post<{ values?: unknown; ai_used?: boolean }>(
      '/api/v1/items/draft/card-copy',
      {
        shop,
        draft: dto.draft,
        template_name: dto.templateName,
        fields: dto.fields.map((f) => ({
          key: f.key,
          max_len: f.maxLen,
          max_lines: f.maxLines ?? 1,
        })),
        language: dto.locale ?? 'en',
      },
    );
    // The reply is a model's: keep only the fields that were asked for, as
    // text, within their limits, so a null or an extra key never reaches
    // the design.
    const raw =
      body.values && typeof body.values === 'object'
        ? (body.values as Record<string, unknown>)
        : {};
    const values: Record<string, string> = {};
    for (const f of dto.fields) {
      const v = raw[f.key];
      const text =
        typeof v === 'string'
          ? v
          : Array.isArray(v)
            ? v
                .filter((x): x is string => typeof x === 'string')
                .join((f.maxLines ?? 1) > 1 ? '\n' : ', ')
            : '';
      const clipped = clipWords(text.trim(), f.maxLen);
      if (clipped) values[f.key] = clipped;
    }
    return { values, aiUsed: Boolean(body.ai_used) };
  }

  private async shopContext(shopId: string, locale?: 'en' | 'bn') {
    const shop = await this.db.query.shops.findFirst({
      where: eq(shops.id, shopId),
      columns: { id: true, name: true, currency: true },
    });
    if (!shop) throw new NotFoundException('Shop not found');
    return {
      id: shop.id,
      name: shop.name,
      currency: shop.currency ?? 'BDT',
      locale: locale ?? 'en',
    };
  }

  private async post<T>(path: string, payload: unknown): Promise<T> {
    if (!this.agentUrl || !this.agentKey) {
      throw new ServiceUnavailableException(
        'The AI assistant is not set up yet.',
      );
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let res: Response;
    try {
      res = await fetch(`${this.agentUrl}${path}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Internal-Key': this.agentKey,
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
    } catch (err) {
      this.log.warn(`item assistant unreachable: ${String(err)}`);
      throw new ServiceUnavailableException(
        'The AI assistant is not available right now.',
      );
    } finally {
      clearTimeout(timer);
    }
    if (res.status === 429) {
      throw new HttpException(
        'Too many messages - please wait a moment and try again.',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    if (!res.ok) {
      this.log.warn(`item assistant returned ${res.status} for ${path}`);
      throw new ServiceUnavailableException(
        'The AI assistant is not available right now.',
      );
    }
    return (await res.json()) as T;
  }
}
