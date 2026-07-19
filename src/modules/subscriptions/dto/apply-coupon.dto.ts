import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

export class ApplyCouponDto {
  @ApiProperty({
    example: 'Hoomri75',
    description:
      'Coupon applied to the next renewal payment (case-insensitive)',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(40)
  code!: string;
}
