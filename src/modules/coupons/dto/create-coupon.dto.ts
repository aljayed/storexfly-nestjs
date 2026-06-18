import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsDateString,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

export class CreateCouponDto {
  @ApiProperty({ example: 'Hoomri75' })
  @IsString()
  @Matches(/^[A-Za-z0-9_-]{3,40}$/, {
    message:
      'Code must be 3–40 characters using letters, numbers, "-" or "_" only',
  })
  code!: string;

  @ApiProperty({ example: 75, description: 'Whole-number percent, 1–100' })
  @IsInt()
  @Min(1)
  @Max(100)
  percentOff!: number;

  @ApiPropertyOptional({ example: '75% off the first shop payment' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  description?: string;

  @ApiPropertyOptional({ description: 'Global redemption cap; omit = unlimited' })
  @IsOptional()
  @IsInt()
  @Min(1)
  maxRedemptions?: number;

  @ApiPropertyOptional({ description: 'ISO expiry date; omit = never expires' })
  @IsOptional()
  @IsDateString()
  expiresAt?: string;
}

export class UpdateCouponDto {
  @ApiPropertyOptional()
  @IsOptional()
  active?: boolean;
}
