import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsDateString,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateIf,
} from 'class-validator';

/** A seller as the operator names them: "@rafiq", "rafiq" or "HM7K3PQR9X". */
const SELLER_REF = /^@?[A-Za-z0-9_.-]{2,32}$/;

export class CreateCouponDto {
  @ApiProperty({ example: 'Hoomri75' })
  @IsString()
  @Matches(/^[A-Za-z0-9_-]{3,40}$/, {
    message:
      'Code must be 3-40 characters using letters, numbers, "-" or "_" only',
  })
  code!: string;

  @ApiProperty({ example: 75, description: 'Whole-number percent, 1-100' })
  @IsInt()
  @Min(1)
  @Max(100)
  percentOff!: number;

  @ApiPropertyOptional({ example: '75% off the first shop payment' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  description?: string;

  @ApiPropertyOptional({
    description: 'Global redemption cap; omit = unlimited',
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  maxRedemptions?: number;

  @ApiPropertyOptional({ description: 'ISO expiry date; omit = never expires' })
  @IsOptional()
  @IsDateString()
  expiresAt?: string;

  @ApiPropertyOptional({
    description:
      'Only a seller who has never made a platform payment may use it',
  })
  @IsOptional()
  @IsBoolean()
  firstPurchaseOnly?: boolean;

  @ApiPropertyOptional({
    example: '@rafiq',
    description:
      'Only this seller may use it - their @handle or public account ID. Omit = any seller.',
  })
  @IsOptional()
  @IsString()
  @Matches(SELLER_REF, {
    message: 'Name the seller by their @handle or account ID',
  })
  user?: string;

  @ApiPropertyOptional({
    example: ['credit-200k'],
    description: 'Only these credit packs; omit or empty = any pack',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  @MaxLength(32, { each: true })
  packCodes?: string[];
}

/**
 * Everything but the code can be changed after the fact. `null` clears an
 * optional rule (no cap, no expiry, any seller, any pack); a field left out
 * is left alone.
 */
export class UpdateCouponDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  active?: boolean;

  @ApiPropertyOptional({ example: 75 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100)
  percentOff?: number;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsString()
  @MaxLength(200)
  description?: string | null;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsInt()
  @Min(1)
  maxRedemptions?: number | null;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsDateString()
  expiresAt?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  firstPurchaseOnly?: boolean;

  @ApiPropertyOptional({ nullable: true, example: '@rafiq' })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsString()
  @Matches(SELLER_REF, {
    message: 'Name the seller by their @handle or account ID',
  })
  user?: string | null;

  @ApiPropertyOptional({ nullable: true, example: ['credit-200k'] })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  @MaxLength(32, { each: true })
  packCodes?: string[] | null;
}
