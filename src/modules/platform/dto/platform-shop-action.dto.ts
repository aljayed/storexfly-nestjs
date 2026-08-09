import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';
import type { NoticeTone } from '../../../database/schema';

const TONES: NoticeTone[] = ['info', 'success', 'warning', 'danger'];

/**
 * Operator actions on one shop, from the console's shop drawer. Both fields
 * are independent switches and either may be sent alone:
 *
 * - `live` is the seller's own storefront switch - the operator nudging a
 *   shop offline (or back on) leaves the seller free to change their mind.
 * - `suspended` is the platform's lock. It forces the shop offline and the
 *   seller cannot undo it; lifting it puts the shop back on sale.
 */
export class UpdatePlatformShopDto {
  @ApiPropertyOptional({ description: "The seller's storefront on/off switch" })
  @IsOptional()
  @IsBoolean()
  live?: boolean;

  @ApiPropertyOptional({ description: 'Lock the shop off, or lift the lock' })
  @IsOptional()
  @IsBoolean()
  suspended?: boolean;

  @ApiPropertyOptional({
    maxLength: 300,
    description:
      'Why the shop is being suspended. Kept on the shop and sent to the ' +
      'seller as an urgent notice. Ignored when lifting a suspension.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(300)
  reason?: string;
}

/** A message from the operator to one shop's seller. */
export class PlatformShopMessageDto {
  @ApiProperty({ maxLength: 300 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(300)
  message!: string;

  @ApiPropertyOptional({ enum: TONES, default: 'info' })
  @IsOptional()
  @IsIn(TONES)
  tone?: NoticeTone;
}
