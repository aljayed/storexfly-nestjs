import { Body, Controller, Get, Patch, UseGuards } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiPropertyOptional,
  ApiTags,
} from '@nestjs/swagger';
import { IsBoolean, IsOptional, IsString, MaxLength } from 'class-validator';
import { Public } from '../../common/decorators/public.decorator';
import { PlatformJwtAuthGuard } from '../../common/guards/platform-jwt-auth.guard';
import { GatewaySettingsService } from '../gateways/gateway-settings.service';

export class UpdateBkashSettingsDto {
  @ApiPropertyOptional() @IsOptional() @IsBoolean() enabled?: boolean;
  @ApiPropertyOptional({ description: 'true = bKash sandbox environment' })
  @IsOptional()
  @IsBoolean()
  sandbox?: boolean;
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(200)
  appKey?: string;
  @ApiPropertyOptional({
    description: 'Write-only; omit to keep the stored value',
  })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  appSecret?: string;
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(200)
  username?: string;
  @ApiPropertyOptional({
    description: 'Write-only; omit to keep the stored value',
  })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  password?: string;
}

/**
 * Operator console: bKash merchant credentials. Secrets are write-only -
 * reads only reveal whether one is stored. (Couriers moved to per-shop
 * settings; see ShopCouriersController.)
 */
@ApiTags('platform-admin')
@Public()
@UseGuards(PlatformJwtAuthGuard)
@ApiBearerAuth()
@Controller('platform/gateways')
export class PlatformGatewaysController {
  constructor(private readonly settings: GatewaySettingsService) {}

  @Get()
  @ApiOperation({
    summary: 'Platform: gateway settings (secrets masked)',
  })
  view() {
    return this.settings.view();
  }

  @Patch('bkash')
  @ApiOperation({ summary: 'Platform: update bKash merchant credentials' })
  updateBkash(@Body() dto: UpdateBkashSettingsDto) {
    return this.settings.updateBkash(dto);
  }
}
