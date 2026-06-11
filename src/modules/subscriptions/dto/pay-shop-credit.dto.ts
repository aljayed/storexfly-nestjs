import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength } from 'class-validator';

export class PayShopCreditDto {
  @ApiPropertyOptional({
    example: 'StoreXFly75',
    description: 'Coupon applied to this first payment (case-insensitive)',
  })
  @IsOptional()
  @IsString()
  @MaxLength(40)
  couponCode?: string;
}
