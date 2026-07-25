import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsNumber,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { Transform, Type } from 'class-transformer';
import type { BuyerGeoValue } from '../../../database/schema';

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

/** A saved map-pin location (nested in PATCH /buyer/profile). */
export class BuyerGeoDto implements BuyerGeoValue {
  @ApiProperty() @IsString() @MaxLength(500) line!: string;
  @ApiProperty() @IsString() @MaxLength(200) area!: string;
  @ApiProperty() @IsString() @MaxLength(24) pin!: string;
  // Reverse-geocoder extras: raw district label + the complete address line.
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(200) district?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(600) full?: string;
  // Exact coordinates from the interactive delivery map.
  @ApiPropertyOptional() @IsOptional() @IsNumber() lat?: number;
  @ApiPropertyOptional() @IsOptional() @IsNumber() lng?: number;
  // Legacy canvas-pin position (percent) — older saved pins only.
  @ApiPropertyOptional() @IsOptional() @IsNumber() x?: number;
  @ApiPropertyOptional() @IsOptional() @IsNumber() y?: number;
}

/**
 * PATCH /buyer/profile — update the display name and/or the saved checkout
 * details. Every field is optional so the screen can send a partial patch
 * (e.g. just the name, or just the saved address).
 */
export class UpdateBuyerProfileDto {
  @ApiProperty({ example: 'Arif Hossain', required: false })
  @IsOptional()
  @IsString()
  @Transform(trim)
  @MinLength(1, { message: 'Name cannot be empty' })
  @MaxLength(160)
  name?: string;

  @ApiProperty({ example: '1712345678', required: false })
  @IsOptional()
  @IsString()
  @Transform(trim)
  @MaxLength(24)
  phone?: string;

  @ApiProperty({ example: 'House 12, Road 5, Dhanmondi', required: false })
  @IsOptional()
  @IsString()
  @Transform(trim)
  @MaxLength(500)
  address?: string;

  @ApiProperty({ example: 'Dhaka', required: false })
  @IsOptional()
  @IsString()
  @Transform(trim)
  @MaxLength(120)
  city?: string;

  @ApiProperty({ example: '1207', required: false })
  @IsOptional()
  @IsString()
  @Transform(trim)
  @MaxLength(24)
  pincode?: string;

  // Pass an object to save the pin, or null to clear it.
  @ApiProperty({ type: BuyerGeoDto, required: false, nullable: true })
  @IsOptional()
  @ValidateNested()
  @Type(() => BuyerGeoDto)
  geo?: BuyerGeoDto | null;

  // Payment method code (platform catalog) from the buyer's latest order —
  // written by checkout so the next order preselects the same method.
  @ApiProperty({ example: 'cod', required: false })
  @IsOptional()
  @IsString()
  @Transform(trim)
  @MaxLength(64)
  lastPayMethod?: string;
}

/** The buyer's account + saved checkout details (GET /buyer/auth/me, PATCH). */
export interface BuyerProfile {
  id: string;
  name: string;
  email: string;
  phone: string | null;
  address: string | null;
  city: string | null;
  pincode: string | null;
  geo: BuyerGeoValue | null;
  lastPayMethod: string | null;
}

/** A seller's still-pending order-amount change awaiting the buyer's decision. */
export interface BuyerOverviewPendingAdjustment {
  id: string;
  /** The current order total the buyer would be moving away from (dollars). */
  previousTotal: number;
  /** The proposed new order total (dollars). */
  newTotal: number;
  reason: string;
  createdAt: string;
}

export interface BuyerOverviewOrder {
  reference: string;
  /** Shop id — needed to address buyer order actions (claim/cancel/approve). */
  shopId: string;
  shopName: string;
  shopHandle: string;
  itemSummary: string;
  qty: number;
  total: number;
  status: string;
  pay: string;
  placedAt: string;
  /** Set when the seller has proposed an amount change awaiting approval. */
  pendingAdjustment: BuyerOverviewPendingAdjustment | null;
}

export interface BuyerOverviewReview {
  id: string;
  rating: number;
  body: string;
  imageUrl: string | null;
  createdAt: string;
  productName: string;
  productSlug: string;
  shopHandle: string;
  shopName: string;
}

/** GET /buyer/profile — everything the profile screen renders, in one payload. */
export interface BuyerOverview {
  buyer: BuyerProfile & { memberSince: string };
  stats: { orders: number; reviews: number; totalSpent: number };
  orders: BuyerOverviewOrder[];
  reviews: BuyerOverviewReview[];
}
