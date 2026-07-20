import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsString, IsUUID, MaxLength } from 'class-validator';

/**
 * POST /buyer/orders/cancel — cancel one of the buyer's own orders while the
 * shop hasn't confirmed it yet. Addressed like a claim: shop + human reference
 * ("#1042"); ownership is the order-email ↔ account match the order list uses.
 */
export class CancelOrderDto {
  @ApiProperty({ example: '7b2f…', format: 'uuid' })
  @IsUUID()
  shopId!: string;

  @ApiProperty({ example: '#1042' })
  @IsString()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @MaxLength(16)
  reference!: string;
}
