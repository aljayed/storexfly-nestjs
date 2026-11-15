import { Body, Controller, Get, Patch, UseGuards } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiPropertyOptional,
  ApiTags,
} from '@nestjs/swagger';
import { IsBoolean, IsString, MaxLength, ValidateIf } from 'class-validator';
import { Public } from '../../common/decorators/public.decorator';
import { PlatformJwtAuthGuard } from '../../common/guards/platform-jwt-auth.guard';
import { PlatformArea } from '../../common/decorators/platform-area.decorator';
import { GatewaySettingsService } from '../gateways/gateway-settings.service';

export class UpdateBkashSettingsDto {
  @ApiPropertyOptional()
  @ValidateIf((_, value) => value !== undefined)
  @IsBoolean()
  enabled?: boolean;
  @ApiPropertyOptional({ description: 'true = bKash sandbox environment' })
  @ValidateIf((_, value) => value !== undefined)
  @IsBoolean()
  sandbox?: boolean;
  @ApiPropertyOptional()
  @ValidateIf((_, value) => value !== undefined)
  @IsString()
  @MaxLength(200)
  appKey?: string;
  @ApiPropertyOptional({
    description: 'Write-only; omit to keep the stored value',
  })
  @ValidateIf((_, value) => value !== undefined)
  @IsString()
  @MaxLength(200)
  appSecret?: string;
  @ApiPropertyOptional()
  @ValidateIf((_, value) => value !== undefined)
  @IsString()
  @MaxLength(200)
  username?: string;
  @ApiPropertyOptional({
    description: 'Write-only; omit to keep the stored value',
  })
  @ValidateIf((_, value) => value !== undefined)
  @IsString()
  @MaxLength(200)
  password?: string;
}

export class UpdateSslcommerzSettingsDto {
  @ApiPropertyOptional()
  @ValidateIf((_, value) => value !== undefined)
  @IsBoolean()
  enabled?: boolean;
  @ApiPropertyOptional({ description: 'true = sandbox.sslcommerz.com' })
  @ValidateIf((_, value) => value !== undefined)
  @IsBoolean()
  sandbox?: boolean;
  @ApiPropertyOptional({ description: 'Merchant panel store id' })
  @ValidateIf((_, value) => value !== undefined)
  @IsString()
  @MaxLength(200)
  storeId?: string;
  @ApiPropertyOptional({
    description: 'Write-only; omit to keep the stored value',
  })
  @ValidateIf((_, value) => value !== undefined)
  @IsString()
  @MaxLength(200)
  storePassword?: string;
}

/**
 * Operator console: bKash and SSLCommerz merchant credentials. Secrets are
 * write-only - reads only reveal whether one is stored. (Couriers have their
 * own screen - see PlatformCouriersController.)
 */
@ApiTags('platform-admin')
@Public()
@UseGuards(PlatformJwtAuthGuard)
@PlatformArea('system')
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

  @Patch('sslcommerz')
  @ApiOperation({ summary: 'Platform: update SSLCommerz store credentials' })
  updateSslcommerz(@Body() dto: UpdateSslcommerzSettingsDto) {
    return this.settings.updateSslcommerz(dto);
  }
}
