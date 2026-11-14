import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';

class ItemAiHistoryTurnDto {
  @IsIn(['user', 'assistant'])
  role!: 'user' | 'assistant';

  @IsString()
  @MaxLength(2000)
  content!: string;
}

class ItemAiEventDto {
  @IsIn(['start', 'message', 'choice', 'image'])
  type!: 'start' | 'message' | 'choice' | 'image';

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  text?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  value?: string;
}

/**
 * One turn of the "add with AI" chat. The draft and flow are opaque here on
 * purpose - the assistant validates every field against the product rules,
 * and the product itself is only ever created through CreateProductDto.
 */
export class ItemAiTurnDto {
  @ApiPropertyOptional({ description: 'The product draft so far (camelCase).' })
  @IsOptional()
  @IsObject()
  draft?: Record<string, unknown>;

  @ApiPropertyOptional({ description: 'Where the conversation stands.' })
  @IsOptional()
  @IsObject()
  flow?: Record<string, unknown>;

  @ApiPropertyOptional({ type: [ItemAiHistoryTurnDto] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(24)
  @ValidateNested({ each: true })
  @Type(() => ItemAiHistoryTurnDto)
  history?: ItemAiHistoryTurnDto[];

  @ApiProperty({ type: ItemAiEventDto })
  @ValidateNested()
  @Type(() => ItemAiEventDto)
  event!: ItemAiEventDto;

  @ApiPropertyOptional({
    description:
      'A small thumbnail of an attached photo, for a category guess.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(400_000)
  imageHint?: string;

  @ApiPropertyOptional({ enum: ['en', 'bn'] })
  @IsOptional()
  @IsIn(['en', 'bn'])
  locale?: 'en' | 'bn';
}

class ItemAiCopyFieldDto {
  @IsString()
  @MaxLength(40)
  key!: string;

  @IsInt()
  @Min(1)
  @Max(300)
  maxLen!: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(6)
  maxLines?: number;
}

/** Words for a photo card's text fields. Prices never come from here. */
export class ItemAiCardCopyDto {
  @ApiProperty()
  @IsObject()
  draft!: Record<string, unknown>;

  @ApiProperty()
  @IsString()
  @MaxLength(120)
  templateName!: string;

  @ApiProperty({ type: [ItemAiCopyFieldDto] })
  @IsArray()
  @ArrayMaxSize(16)
  @ValidateNested({ each: true })
  @Type(() => ItemAiCopyFieldDto)
  fields!: ItemAiCopyFieldDto[];

  @ApiPropertyOptional({ enum: ['en', 'bn'] })
  @IsOptional()
  @IsIn(['en', 'bn'])
  locale?: 'en' | 'bn';
}

/** A description for the manual add-item form, from what it holds so far. */
export class ItemAiDescribeDto {
  @ApiProperty()
  @IsString()
  @MinLength(2)
  @MaxLength(200)
  name!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(80)
  category?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(60)
  unit?: string;

  @ApiPropertyOptional({
    description: 'One line per option group, e.g. "Size: S, M, L".',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(3)
  @IsString({ each: true })
  @MaxLength(200, { each: true })
  options?: string[];

  @ApiPropertyOptional({
    description: 'What the seller has written already, to improve.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  existing?: string;

  @ApiPropertyOptional({ description: 'A small thumbnail of the cover photo.' })
  @IsOptional()
  @IsString()
  @MaxLength(400_000)
  imageHint?: string;

  @ApiPropertyOptional({ enum: ['en', 'bn'] })
  @IsOptional()
  @IsIn(['en', 'bn'])
  locale?: 'en' | 'bn';
}
