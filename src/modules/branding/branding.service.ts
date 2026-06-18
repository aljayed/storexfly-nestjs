import {
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  type OnModuleInit,
} from '@nestjs/common';
import { asc, desc, eq } from 'drizzle-orm';
import { DRIZZLE } from '../../database/database.constants';
import type { DrizzleDB } from '../../database/drizzle.types';
import {
  brandLogos,
  platformSettings,
  type PlatformSettingsRow,
} from '../../database/schema';
import {
  BrandingResponse,
  LogoResponse,
  type LogoTheme,
  UpdateBrandingDto,
} from './dto/branding.dto';

/** Most-recent uploaded logos kept selectable in the gallery. */
const GALLERY_LIMIT = 12;

/**
 * Platform branding — the logo shown across every surface, either a text
 * wordmark or an uploaded image. Backed by a singleton {@link platformSettings}
 * row (seeded at boot) plus a {@link brandLogos} gallery of recent uploads.
 */
@Injectable()
export class BrandingService implements OnModuleInit {
  private readonly logger = new Logger(BrandingService.name);

  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDB) {}

  async onModuleInit(): Promise<void> {
    try {
      const existing = await this.row();
      if (!existing) {
        await this.db.insert(platformSettings).values({});
        this.logger.log('Seeded default platform branding');
      }
    } catch (err) {
      this.logger.error('Failed to ensure platform branding', err as Error);
    }
  }

  /** The singleton settings row (oldest by id ordering), or undefined. */
  private async row(): Promise<PlatformSettingsRow | undefined> {
    const [row] = await this.db
      .select()
      .from(platformSettings)
      .orderBy(asc(platformSettings.id))
      .limit(1);
    return row;
  }

  /** Ensures the singleton exists and returns it. */
  private async ensureRow(): Promise<PlatformSettingsRow> {
    const existing = await this.row();
    if (existing) return existing;
    const [row] = await this.db.insert(platformSettings).values({}).returning();
    return row;
  }

  /** Current branding — falls back to the code default before the seed lands. */
  async get(): Promise<BrandingResponse> {
    const row = await this.row();
    return row
      ? BrandingResponse.fromRow(row)
      : {
          wordmark: 'hoomri',
          accent: 'oo',
          logoLight: null,
          logoDark: null,
          favicon: null,
        };
  }

  /** Update the wordmark / accent / per-theme active logos. */
  async update(dto: UpdateBrandingDto): Promise<BrandingResponse> {
    const existing = await this.ensureRow();
    const patch: Partial<PlatformSettingsRow> = {
      brandWordmark: dto.wordmark,
      brandAccent: dto.accent?.length ? dto.accent : null,
    };
    // Only touch a slot when the caller sent the field (null clears it).
    if (dto.logoLight !== undefined) patch.logoLight = dto.logoLight;
    if (dto.logoDark !== undefined) patch.logoDark = dto.logoDark;
    if (dto.favicon !== undefined) patch.favicon = dto.favicon;

    const [row] = await this.db
      .update(platformSettings)
      .set(patch)
      .where(eq(platformSettings.id, existing.id))
      .returning();
    return BrandingResponse.fromRow(row);
  }

  // ── Logo gallery ───────────────────────────────────────────────

  /** Recent uploaded logos, newest first. */
  async listLogos(): Promise<LogoResponse[]> {
    const rows = await this.db
      .select()
      .from(brandLogos)
      .orderBy(desc(brandLogos.createdAt))
      .limit(GALLERY_LIMIT);
    return rows.map(LogoResponse.fromRow);
  }

  /** Store an uploaded image and make it the active logo for the given theme. */
  async addLogo(dataUrl: string, theme: LogoTheme): Promise<BrandingResponse> {
    await this.db.insert(brandLogos).values({ dataUrl });
    return this.update({
      ...(await this.currentText()),
      ...(theme === 'dark' ? { logoDark: dataUrl } : { logoLight: dataUrl }),
    });
  }

  /** Remove a gallery image; clears any theme slot that was showing it. */
  async removeLogo(id: string): Promise<BrandingResponse> {
    const [row] = await this.db
      .delete(brandLogos)
      .where(eq(brandLogos.id, id))
      .returning();
    if (!row) throw new NotFoundException('Image not found');

    const settings = await this.ensureRow();
    const patch: Partial<PlatformSettingsRow> = {};
    if (settings.logoLight === row.dataUrl) patch.logoLight = null;
    if (settings.logoDark === row.dataUrl) patch.logoDark = null;
    if (Object.keys(patch).length === 0) return BrandingResponse.fromRow(settings);

    const [updated] = await this.db
      .update(platformSettings)
      .set(patch)
      .where(eq(platformSettings.id, settings.id))
      .returning();
    return BrandingResponse.fromRow(updated);
  }

  /** The text portion of the current brand, for re-saving alongside a logo. */
  private async currentText(): Promise<{ wordmark: string; accent?: string }> {
    const row = await this.ensureRow();
    return {
      wordmark: row.brandWordmark,
      accent: row.brandAccent ?? undefined,
    };
  }
}
