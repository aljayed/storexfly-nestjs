import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
} from 'class-validator';

export class CreateReferralLinkDto {
  @ApiProperty({
    example: 'rahim-fb',
    description: 'URL path of the link (hoomri.com/r/<slug>), case-insensitive',
  })
  @IsString()
  @Matches(/^[A-Za-z0-9_-]{3,60}$/, {
    message:
      'Slug must be 3-60 characters using letters, numbers, "-" or "_" only',
  })
  slug!: string;

  @ApiProperty({ description: 'Coupon the link auto-applies' })
  @IsUUID()
  couponId!: string;

  @ApiPropertyOptional({ example: 'Facebook campaign - July' })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  name?: string;
}

export class UpdateReferralLinkDto {
  @ApiPropertyOptional()
  @IsOptional()
  active?: boolean;
}
