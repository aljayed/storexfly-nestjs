import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import {
  listingTypeEnum,
  productTagEnum,
} from '../../../database/schema/enums';

/** Rows per request - small, so remote photos can't outlast a proxy timeout. */
export const IMPORT_ROWS_PER_REQUEST = 10;

/**
 * The request body. Rows are deliberately *not* validated here: one bad cell
 * in row 7 must not reject rows 1-10 with a single 400. Each row is checked on
 * its own against {@link ImportRowDto} and gets its own result.
 */
export class ImportProductsDto {
  @ApiProperty({
    type: 'array',
    items: { type: 'object' },
    description: `Up to ${IMPORT_ROWS_PER_REQUEST} rows, each shaped like ImportRowDto. Validated one by one.`,
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(IMPORT_ROWS_PER_REQUEST)
  rows!: unknown[];

  @ApiPropertyOptional({
    enum: ['update', 'skip'],
    default: 'update',
    description:
      'What to do with a row whose item already exists (same link ID, or same name).',
  })
  @IsOptional()
  @IsIn(['update', 'skip'])
  onExisting?: 'update' | 'skip';
}

/** "Size: S, M, L" - an option group with plain choices (no price deltas). */
export class ImportVariantGroupDto {
  @IsString()
  @MinLength(1, { message: 'An option group needs a name, like "Size".' })
  @MaxLength(40, {
    message: 'Option group names can be at most 40 characters.',
  })
  name!: string;

  @IsArray()
  @ArrayMinSize(1, { message: 'An option group has no choices.' })
  @ArrayMaxSize(12, { message: 'An option group can have at most 12 choices.' })
  @IsString({ each: true })
  @MinLength(1, { each: true, message: 'An option choice is empty.' })
  @MaxLength(40, {
    each: true,
    message: 'Option choices can be at most 40 characters.',
  })
  options!: string[];
}

/**
 * One spreadsheet row after the browser has read the cells into types. The
 * messages are written for a seller looking at their own file, since they are
 * shown next to the row number as-is.
 */
export class ImportRowDto {
  @IsOptional()
  @IsString()
  @MaxLength(220)
  slug?: string;

  @IsString({ message: 'Name is missing.' })
  @MinLength(2, { message: 'Name must be at least 2 characters.' })
  @MaxLength(200, { message: 'Name can be at most 200 characters.' })
  name!: string;

  @IsOptional()
  @IsString()
  @MaxLength(80, { message: 'Category can be at most 80 characters.' })
  cat?: string;

  @IsOptional()
  @IsIn(listingTypeEnum.enumValues, {
    message: 'Listing type must be "sale" or "showcase".',
  })
  listingType?: (typeof listingTypeEnum.enumValues)[number];

  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 }, { message: 'Price must be a number.' })
  @Min(0, { message: 'Price cannot be negative.' })
  @Max(100_000_000, { message: 'Price is too large.' })
  price?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber(
    { maxDecimalPlaces: 2 },
    { message: 'Regular price must be a number.' },
  )
  @Min(0, { message: 'Regular price cannot be negative.' })
  @Max(100_000_000, { message: 'Regular price is too large.' })
  comparePrice?: number;

  @IsOptional()
  @IsString()
  @MaxLength(60, { message: 'Unit can be at most 60 characters.' })
  unit?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'Stock must be a whole number.' })
  @Min(0, { message: 'Stock cannot be negative.' })
  @Max(1_000_000, { message: 'Stock can be at most 1,000,000.' })
  stock?: number;

  @IsOptional()
  @IsIn(productTagEnum.enumValues, {
    message: 'Tag "$value" is not one of ours.',
  })
  tag?: (typeof productTagEnum.enumValues)[number];

  @IsOptional()
  @IsString()
  @MaxLength(2000, { message: 'Description can be at most 2000 characters.' })
  blurb?: string;

  @IsOptional()
  @Type(() => Number)
  @IsNumber(
    { maxDecimalPlaces: 2 },
    { message: 'Delivery charge inside Dhaka must be a number.' },
  )
  @Min(0, { message: 'Delivery charge inside Dhaka cannot be negative.' })
  @Max(100_000, { message: 'Delivery charge inside Dhaka is too large.' })
  deliveryDhaka?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber(
    { maxDecimalPlaces: 2 },
    { message: 'Delivery charge outside Dhaka must be a number.' },
  )
  @Min(0, { message: 'Delivery charge outside Dhaka cannot be negative.' })
  @Max(100_000, { message: 'Delivery charge outside Dhaka is too large.' })
  deliveryOutside?: number;

  @IsOptional()
  @IsString()
  @MaxLength(16, { message: 'Emoji is too long.' })
  emoji?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  @Matches(
    /^(https?:\/\/)?(www\.)?(youtube\.com\/(watch\?v=|embed\/|shorts\/)|youtu\.be\/)[\w-]{11}/,
    { message: 'Video must be a YouTube link.' },
  )
  videoUrl?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(8, { message: 'An item can have at most 8 photos.' })
  @IsString({ each: true })
  @MaxLength(2000, { each: true, message: 'A photo link is too long.' })
  images?: string[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(2, {
    message: 'At most 2 option groups can be imported (e.g. Size and Color).',
  })
  @ValidateNested({ each: true })
  @Type(() => ImportVariantGroupDto)
  variants?: ImportVariantGroupDto[];
}

export type ImportRowStatus = 'created' | 'updated' | 'skipped' | 'failed';

export class ImportRowResult {
  @ApiProperty({ enum: ['created', 'updated', 'skipped', 'failed'] })
  status!: ImportRowStatus;

  @ApiPropertyOptional()
  id?: string;

  @ApiPropertyOptional()
  slug?: string;

  @ApiPropertyOptional({ type: [String], description: 'Why the row failed.' })
  errors?: string[];

  @ApiPropertyOptional({
    type: [String],
    description: 'Saved, but something was left out (e.g. a photo link).',
  })
  warnings?: string[];
}

export class ImportProductsResponse {
  @ApiProperty({
    type: [ImportRowResult],
    description: 'One result per row, in the order sent.',
  })
  results!: ImportRowResult[];
}

/** Guard for the loose body rows before class-transformer sees them. */
export const isPlainRow = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
