import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsString, IsUUID, MaxLength } from 'class-validator';

/**
 * POST /buyer/orders/claim — link a just-placed guest order to the signed-in
 * buyer. The order is addressed by its shop + human reference ("#1042"); the
 * server authorizes the link by matching the order's phone to the account's.
 */
export class ClaimOrderDto {
  @ApiProperty({ example: '7b2f…', format: 'uuid' })
  @IsUUID()
  shopId!: string;

  @ApiProperty({ example: '#1042' })
  @IsString()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @MaxLength(16)
  reference!: string;
}
