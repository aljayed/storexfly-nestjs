import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, Length } from 'class-validator';

export class BuyCreditsDto {
  @ApiProperty({
    example: 'credit-200k',
    description: 'Which pack from the shelf to buy',
  })
  @IsString()
  @Length(1, 32)
  packCode!: string;

  @ApiPropertyOptional({
    example: 'LAUNCH50',
    description: 'Discount code applied to this purchase',
  })
  @IsOptional()
  @IsString()
  @Length(1, 40)
  couponCode?: string;

  @ApiPropertyOptional({
    example: 'ramadan-push',
    description: 'Referral link the seller arrived through, for attribution',
  })
  @IsOptional()
  @IsString()
  @Length(1, 60)
  refSlug?: string;

  @ApiPropertyOptional({
    enum: ['sslcommerz', 'bkash'],
    description:
      'Which gateway to pay on. Omitted, the first available one is used. ' +
      'Ignored when a coupon makes the pack free.',
  })
  @IsOptional()
  @IsIn(['sslcommerz', 'bkash'])
  gateway?: 'sslcommerz' | 'bkash';
}
