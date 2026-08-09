import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/** Platform-operator view of a shop, with owner contact + recent sales. */
export class PlatformShopResponse {
  @ApiProperty() id!: string;
  @ApiProperty({ example: 'Maya Kitchen' }) name!: string;
  @ApiProperty({ example: 'maya-kitchen' }) handle!: string;
  @ApiProperty({ description: 'Shop owner display name' }) ownerName!: string;
  @ApiPropertyOptional({ description: 'Owner email (login)' })
  email?: string;
  @ApiPropertyOptional({ description: 'Owner phone, or shop support phone' })
  phone?: string;
  @ApiProperty({ example: 'BDT' }) currency!: string;
  @ApiProperty({ description: 'Storefront live (buyer-facing) switch' })
  live!: boolean;
  /** Locked off by the operator. A suspended shop is never live. */
  @ApiProperty({ description: 'Suspended by the platform operator' })
  suspended!: boolean;
  /** Paid sales in the last 30 days, in the shop's currency (major units). */
  @ApiProperty({ example: 18420 }) sales30d!: number;
  /** Paid orders in the last 30 days. */
  @ApiProperty({ example: 42 }) orders30d!: number;
  @ApiProperty() createdAt!: string;
}

/** Paginated platform-admin shop list. `total` counts the filtered set. */
export class PlatformShopListResponse {
  @ApiProperty({ type: [PlatformShopResponse] }) data!: PlatformShopResponse[];
  @ApiProperty() total!: number;
  @ApiProperty() page!: number;
  @ApiProperty() limit!: number;
}

/**
 * One shop, for the operator's detail drawer: everything the list row has,
 * plus the context needed to decide whether to suspend it - lifetime trade,
 * catalog size, verification state and how the shop is billed.
 */
export class PlatformShopDetailResponse extends PlatformShopResponse {
  @ApiPropertyOptional({ example: 'Home-cooked, delivered warm' })
  tagline?: string;
  @ApiProperty({ example: 'Food & grocery' }) cat!: string;
  @ApiProperty({ example: 'en' }) language!: string;
  @ApiProperty({ enum: ['free', 'paid'] }) plan!: string;
  @ApiProperty({ description: 'AI auto-reply enabled in the seller inbox' })
  botChatEnabled!: boolean;
  @ApiProperty({ enum: ['unsubmitted', 'pending', 'verified', 'rejected'] })
  kycStatus!: string;
  @ApiPropertyOptional({ description: 'When the operator suspended the shop' })
  suspendedAt?: string;
  @ApiPropertyOptional({ description: 'Reason shown to the seller' })
  suspendedReason?: string;
  @ApiPropertyOptional({ description: 'Buyer-facing support email' })
  supportEmail?: string;
  @ApiProperty({ description: 'A payout account is on file' })
  hasPayoutBank!: boolean;
  @ApiProperty({ description: 'Products in the catalog' }) products!: number;
  @ApiProperty({ description: 'Orders ever placed' }) ordersTotal!: number;
  /** Paid sales over the shop's whole life, in major units. */
  @ApiProperty({ example: 184200 }) salesTotal!: number;
  @ApiProperty({ description: 'Buyers who have ordered from this shop' })
  customers!: number;
  @ApiPropertyOptional({ description: 'When the last order was placed' })
  lastOrderAt?: string;
  @ApiPropertyOptional({ enum: ['credits', 'commission'] })
  billingMode?: string;
  @ApiPropertyOptional({ enum: ['active', 'past_due', 'cancelled'] })
  billingStatus?: string;
  /** Commission billed but not yet collected, in major units. */
  @ApiPropertyOptional({ example: 1250 }) dueAmount?: number;
}
