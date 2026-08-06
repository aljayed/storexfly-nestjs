import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiProperty,
  ApiPropertyOptional,
  ApiTags,
} from '@nestjs/swagger';
import { IsBoolean, IsOptional, IsString, MaxLength } from 'class-validator';
import { Public } from '../../common/decorators/public.decorator';
import { PlatformJwtAuthGuard } from '../../common/guards/platform-jwt-auth.guard';
import { CarrybeeService } from '../gateways/carrybee.service';
import { CourierSettingsService } from '../gateways/courier-settings.service';

const WRITE_ONLY = 'Write-only; omit to keep the stored value';

export class UpdateCarrybeeSettingsDto {
  @ApiPropertyOptional() @IsOptional() @IsBoolean() enabled?: boolean;
  @ApiPropertyOptional({
    description: 'true = developers.carrybee.com; false = the sandbox host',
  })
  @IsOptional()
  @IsBoolean()
  production?: boolean;
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(200)
  clientId?: string;
  @ApiPropertyOptional({ description: WRITE_ONLY })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  clientSecret?: string;
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(200)
  clientContext?: string;
  @ApiPropertyOptional({
    description: `${WRITE_ONLY}. Secret CarryBee echoes on its webhook`,
  })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  webhookSecret?: string;
}

export class UpdatePlatformSteadfastDto {
  @ApiPropertyOptional() @IsOptional() @IsBoolean() enabled?: boolean;
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(200)
  apiKey?: string;
  @ApiPropertyOptional({ description: WRITE_ONLY })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  secretKey?: string;
}

export class UpdatePlatformPathaoDto {
  @ApiPropertyOptional() @IsOptional() @IsBoolean() enabled?: boolean;
  @ApiPropertyOptional({ description: 'true = the live Pathao host' })
  @IsOptional()
  @IsBoolean()
  production?: boolean;
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(200)
  clientId?: string;
  @ApiPropertyOptional({ description: WRITE_ONLY })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  clientSecret?: string;
  @ApiPropertyOptional({ description: 'Pathao merchant account email' })
  @IsOptional()
  @IsString()
  @MaxLength(254)
  username?: string;
  @ApiPropertyOptional({ description: WRITE_ONLY })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  password?: string;
}

export class SetCourierRequiredDto {
  @ApiProperty({
    description: 'true = shops may only ship through the platform courier',
  })
  @IsBoolean()
  required!: boolean;
}

/**
 * Operator console: the platform's own courier merchant credentials. Secrets
 * are write-only - reads only reveal whether one is stored.
 *
 * Sellers have no equivalent screen. Couriers are deliberately not per-shop:
 * a shop booking parcels on its own account owns the whole fulfilment record
 * and can keep the sales it is billed on off the platform's books entirely.
 */
@ApiTags('platform-admin')
@Public()
@UseGuards(PlatformJwtAuthGuard)
@ApiBearerAuth()
@Controller('platform/couriers')
export class PlatformCouriersController {
  constructor(
    private readonly settings: CourierSettingsService,
    private readonly carrybee: CarrybeeService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'Platform: courier settings (secrets masked)' })
  view() {
    return this.settings.view();
  }

  @Patch('carrybee')
  @ApiOperation({ summary: 'Platform: update CarryBee credentials' })
  updateCarrybee(@Body() dto: UpdateCarrybeeSettingsDto) {
    return this.settings.updateCarrybee(dto);
  }

  @Patch('steadfast')
  @ApiOperation({ summary: 'Platform: update Steadfast credentials' })
  updateSteadfast(@Body() dto: UpdatePlatformSteadfastDto) {
    return this.settings.updateSteadfast(dto);
  }

  @Patch('pathao')
  @ApiOperation({ summary: 'Platform: update Pathao credentials' })
  updatePathao(@Body() dto: UpdatePlatformPathaoDto) {
    return this.settings.updatePathao(dto);
  }

  @Patch('required')
  @ApiOperation({
    summary:
      'Platform: confine shops to the platform courier (or release them)',
  })
  setRequired(@Body() dto: SetCourierRequiredDto) {
    return this.settings.setCourierRequired(dto.required);
  }

  /**
   * Round-trip the saved credentials. Cheaper to find out here than on a
   * seller's first booking - and there is no store to check any more, since
   * each shop registers its own pickup point when it first ships.
   */
  @Post('carrybee/verify')
  @ApiOperation({ summary: 'Platform: check the saved CarryBee credentials' })
  async verifyCarrybee() {
    await this.carrybee.verify(await this.requireCarrybee());
    return { ok: true };
  }

  private async requireCarrybee() {
    const config = await this.settings.carrybeeConfig();
    if (!config) {
      throw new BadRequestException(
        'Save the CarryBee client ID, secret and context first.',
      );
    }
    return config;
  }
}
