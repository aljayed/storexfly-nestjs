import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, MaxLength, Min, ValidateIf } from 'class-validator';

/** Shared by onboarding and settings; full-address rules run on the merged shop. */
export class DeliverySettingsDto {
  @ApiPropertyOptional({ enum: ['manual', 'carrybee'] })
  @ValidateIf((_object, value) => value !== undefined) @IsIn(['manual', 'carrybee'])
  deliveryMode?: 'manual' | 'carrybee';

  @ApiPropertyOptional()
  @IsOptional() @IsString() @MaxLength(80)
  @Transform(({ value }) => typeof value === 'string' ? value.trim() : value)
  pickupDistrict?: string;

  @ApiPropertyOptional()
  @IsOptional() @IsString() @MaxLength(60)
  @Transform(({ value }) => typeof value === 'string' ? value.trim() : value)
  pickupContactName?: string;

  @ApiPropertyOptional()
  @IsOptional() @IsString() @MaxLength(24)
  @Transform(({ value }) => typeof value === 'string' ? value.trim() : value)
  pickupPhone?: string;

  @ApiPropertyOptional()
  @IsOptional() @IsString() @MaxLength(200)
  @Transform(({ value }) => typeof value === 'string' ? value.trim() : value)
  pickupAddress?: string;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional() @IsInt() @Min(1)
  pickupCityId?: number | null;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional() @IsInt() @Min(1)
  pickupZoneId?: number | null;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional() @IsInt() @Min(1)
  pickupAreaId?: number | null;
}
