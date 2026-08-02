import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsIn,
  IsOptional,
  IsString,
  Length,
  Matches,
  MaxLength,
  ValidateIf,
} from 'class-validator';
import type {
  BrandLogoRow,
  PlatformSettingsRow,
} from '../../../database/schema';

/** Which background a logo image is for. */
export type LogoTheme = 'light' | 'dark';

/** Patch the platform brand - text wordmark and/or the active image logo. */
export class UpdateBrandingDto {
  @ApiProperty({ example: 'hoomri', description: 'The logotype text' })
  @IsString()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @Length(1, 40)
  wordmark!: string;

  @ApiPropertyOptional({
    example: 'oo',
    description:
      'Substring of the wordmark to tint in the accent colour. Empty = none.',
  })
  @IsOptional()
  @IsString()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @MaxLength(40)
  accent?: string;

  @ApiPropertyOptional({
    description:
      'Logo for light backgrounds as a data URL, or null to use the wordmark.',
    nullable: true,
  })
  @IsOptional()
  // Allow explicit null (clear the logo); otherwise it must be a data: URL.
  @ValidateIf((_, v) => v !== null)
  @IsString()
  @Matches(/^data:image\//, { message: 'logoLight must be an image data URL' })
  logoLight?: string | null;

  @ApiPropertyOptional({
    description:
      'Logo for dark backgrounds as a data URL, or null to use the wordmark.',
    nullable: true,
  })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsString()
  @Matches(/^data:image\//, { message: 'logoDark must be an image data URL' })
  logoDark?: string | null;

  @ApiPropertyOptional({
    description:
      'Browser-tab icon as a data URL, or null to use the default favicon.',
    nullable: true,
  })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsString()
  @Matches(/^data:image\//, { message: 'favicon must be an image data URL' })
  favicon?: string | null;
}

/** A single uploaded logo image, assigned to one theme. */
export class AddLogoDto {
  @ApiProperty({ description: 'Resized image as a data URL' })
  @IsString()
  @Matches(/^data:image\//, { message: 'dataUrl must be an image data URL' })
  dataUrl!: string;

  @ApiProperty({ enum: ['light', 'dark'], description: 'Background it is for' })
  @IsIn(['light', 'dark'])
  theme!: LogoTheme;
}

/** Public brand descriptor consumed by every front-end surface. */
export class BrandingResponse {
  @ApiProperty({ example: 'hoomri' }) wordmark!: string;
  @ApiProperty({ example: 'oo', nullable: true }) accent!: string | null;
  @ApiProperty({ nullable: true }) logoLight!: string | null;
  @ApiProperty({ nullable: true }) logoDark!: string | null;
  @ApiProperty({ nullable: true }) favicon!: string | null;

  static fromRow(row: PlatformSettingsRow): BrandingResponse {
    return {
      wordmark: row.brandWordmark,
      accent: row.brandAccent ?? null,
      logoLight: row.logoLight ?? null,
      logoDark: row.logoDark ?? null,
      favicon: row.favicon ?? null,
    };
  }
}

/** A gallery entry shown under "recent images". */
export class LogoResponse {
  @ApiProperty() id!: string;
  @ApiProperty() url!: string;
  @ApiProperty() createdAt!: string;

  static fromRow(row: BrandLogoRow): LogoResponse {
    return {
      id: row.id,
      url: row.dataUrl,
      createdAt: row.createdAt.toISOString(),
    };
  }
}
