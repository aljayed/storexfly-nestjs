import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength } from 'class-validator';

export class PayShopCreditDto {
  @ApiPropertyOptional({
    example: 'Hoomri75',
    description: 'Coupon applied to this first payment (case-insensitive)',
  })
  @IsOptional()
  @IsString()
  @MaxLength(40)
  couponCode?: string;

  @ApiPropertyOptional({
    example: 'rahim-fb',
    description:
      'Referral-link slug the coupon arrived through, for attribution only',
  })
  @IsOptional()
  @IsString()
  @MaxLength(60)
  refSlug?: string;
}
