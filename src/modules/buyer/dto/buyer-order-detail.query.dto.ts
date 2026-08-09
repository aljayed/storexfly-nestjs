import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsString, IsUUID, MaxLength } from 'class-validator';

/**
 * GET /buyer/orders/detail - one of the buyer's own orders in full. Addressed
 * like the other buyer order actions: shop + human reference ("#1042"), with
 * ownership resolved from the order-email ↔ account match.
 */
export class BuyerOrderDetailQueryDto {
  @ApiProperty({ example: '7b2f…', format: 'uuid' })
  @IsUUID()
  shopId!: string;

  @ApiProperty({ example: '#1042' })
  @IsString()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @MaxLength(16)
  reference!: string;
}
