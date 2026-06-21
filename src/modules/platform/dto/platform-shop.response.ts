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
