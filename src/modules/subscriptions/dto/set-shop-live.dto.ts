import { ApiProperty } from '@nestjs/swagger';
import { IsBoolean } from 'class-validator';

export class SetShopLiveDto {
  @ApiProperty({ description: 'Whether buyers can reach the storefront' })
  @IsBoolean()
  live!: boolean;
}
