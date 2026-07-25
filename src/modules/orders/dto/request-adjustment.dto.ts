import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsNumber, IsString, MaxLength, MinLength, Min } from 'class-validator';

/**
 * POST /shops/:shopId/orders/:id/adjustment — the seller proposes a new order
 * total (major units, e.g. 1500 = ৳1,500) with a reason. The buyer must approve
 * it before it replaces the order total.
 */
export class RequestAdjustmentDto {
  @ApiProperty({ example: 1500, description: 'Proposed new order total (BDT)' })
  @IsNumber()
  @Min(0.01)
  newTotal!: number;

  @ApiProperty({ example: 'Added gift wrapping + custom engraving' })
  @IsString()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @MinLength(1, { message: 'Add a short reason for the change.' })
  @MaxLength(300)
  reason!: string;
}
