import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsBoolean, IsString, IsUUID, MaxLength } from 'class-validator';

/**
 * POST /buyer/orders/adjustment/respond - the buyer approves or declines a
 * seller's pending order-amount change. Addressed like the buyer cancel: shop +
 * human reference ("#1042"); ownership is the order-email ↔ account match.
 */
export class RespondAdjustmentDto {
  @ApiProperty({ example: '7b2f…', format: 'uuid' })
  @IsUUID()
  shopId!: string;

  @ApiProperty({ example: '#1042' })
  @IsString()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @MaxLength(16)
  reference!: string;

  @ApiProperty({ example: 'b91c…', format: 'uuid' })
  @IsUUID()
  adjustmentId!: string;

  @ApiProperty({ example: true, description: 'true = approve, false = decline' })
  @IsBoolean()
  approve!: boolean;
}
