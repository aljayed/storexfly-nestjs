import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiProperty,
  ApiPropertyOptional,
  ApiTags,
} from '@nestjs/swagger';
import {
  IsBoolean,
  IsIn,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { Public } from '../../common/decorators/public.decorator';
import { PlatformJwtAuthGuard } from '../../common/guards/platform-jwt-auth.guard';
import {
  PaymentMethodsService,
  type OnlineMethodKind,
  type PaymentGatewayChoice,
} from './payment-methods.service';

export class PaymentMethodResponse {
  @ApiProperty() id!: string;
  @ApiProperty({ example: 'bkash', description: 'Stable slug orders store' })
  code!: string;
  @ApiProperty({
    enum: ['mbank', 'card', 'cod'],
    description:
      'Checkout behaviour: wallet flow, card form, or pay-on-delivery',
  })
  kind!: 'mbank' | 'card' | 'cod';
  @ApiProperty({ example: 'bKash' }) title!: string;
  @ApiProperty({ example: 'Pay from your bKash wallet', nullable: true })
  subtitle!: string | null;
  @ApiProperty({ example: 3, description: 'Processing fee %' })
  feePercent!: number;
  @ApiProperty({ description: 'true only for the built-in COD method' })
  locked!: boolean;
  @ApiProperty({
    description:
      'Off = offered nowhere: gone from checkout and every payment picker',
  })
  enabled!: boolean;
  @ApiProperty({
    enum: ['none', 'bkash', 'sslcommerz'],
    description:
      "'bkash'/'sslcommerz' = platform-collected via that gateway (fee + payout); 'none' = direct/COD",
  })
  gateway!: PaymentGatewayChoice;
}

export class PaymentConfigResponse {
  @ApiProperty({ type: [PaymentMethodResponse] })
  methods!: PaymentMethodResponse[];
  @ApiProperty({
    nullable: true,
    description: 'Operator-set settlements info banner; null = default copy',
  })
  banner!: string | null;
}

export class CreatePaymentMethodDto {
  @ApiProperty({ enum: ['mbank', 'card'] })
  @IsIn(['mbank', 'card'])
  kind!: OnlineMethodKind;

  @ApiProperty({ example: 'bKash' })
  @IsString()
  @MaxLength(80)
  title!: string;

  @ApiPropertyOptional({ example: 'Pay from your bKash wallet' })
  @IsOptional()
  @IsString()
  @MaxLength(140)
  subtitle?: string;

  @ApiProperty({ example: 3, description: 'Processing fee %' })
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(25)
  feePercent!: number;
}

export class UpdatePaymentMethodDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(80)
  title?: string;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(140)
  subtitle?: string;

  @ApiPropertyOptional({ example: 3 })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(25)
  feePercent?: number;

  @ApiPropertyOptional({ enum: ['none', 'bkash', 'sslcommerz'] })
  @IsOptional()
  @IsIn(['none', 'bkash', 'sslcommerz'])
  gateway?: PaymentGatewayChoice;

  @ApiPropertyOptional({
    description:
      'Switch the method on or off everywhere at once. Refused for Cash on ' +
      'Delivery, which every shop falls back on.',
  })
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;
}

export class UpdateSettlementBannerDto {
  @ApiPropertyOptional({
    nullable: true,
    description: 'Banner text; empty/null restores the default copy',
  })
  @IsOptional()
  @IsString()
  @MaxLength(600)
  banner?: string | null;
}

/**
 * The checkout payment-method catalog. Reading is public - the storefront
 * checkout, product page and seller console all render from it. Managing the
 * catalog (and the seller settlements-page banner) is platform-operator only.
 */
@ApiTags('platform-admin')
@Controller('platform/payment-methods')
export class PaymentMethodsController {
  constructor(private readonly methods: PaymentMethodsService) {}

  @Get()
  @Public()
  @ApiOperation({ summary: 'Enabled payment methods + settlements banner' })
  @ApiOkResponse({ type: PaymentConfigResponse })
  async list(): Promise<PaymentConfigResponse> {
    const [methods, banner] = await Promise.all([
      this.methods.listEnabled(),
      this.methods.getBanner(),
    ]);
    return { methods, banner };
  }

  @Get('all')
  @Public()
  @UseGuards(PlatformJwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Platform admin: every payment method, switched-off ones included',
  })
  @ApiOkResponse({ type: PaymentConfigResponse })
  async listAll(): Promise<PaymentConfigResponse> {
    const [methods, banner] = await Promise.all([
      this.methods.listAll(),
      this.methods.getBanner(),
    ]);
    return { methods, banner };
  }

  @Post()
  @Public()
  @UseGuards(PlatformJwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Platform admin: add a payment method' })
  @ApiOkResponse({ type: PaymentMethodResponse })
  create(@Body() dto: CreatePaymentMethodDto) {
    return this.methods.create(dto);
  }

  @Patch('banner')
  @Public()
  @UseGuards(PlatformJwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Platform admin: edit the settlements info banner' })
  async setBanner(@Body() dto: UpdateSettlementBannerDto) {
    return { banner: await this.methods.setBanner(dto.banner ?? null) };
  }

  @Patch(':id')
  @Public()
  @UseGuards(PlatformJwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Platform admin: edit a payment method' })
  @ApiOkResponse({ type: PaymentMethodResponse })
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdatePaymentMethodDto,
  ) {
    return this.methods.update(id, dto);
  }

  @Delete(':id')
  @Public()
  @UseGuards(PlatformJwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      'Platform admin: remove a payment method (kept internally if orders used it)',
  })
  remove(@Param('id', ParseUUIDPipe) id: string) {
    return this.methods.remove(id);
  }
}
