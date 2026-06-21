import { ApiProperty } from '@nestjs/swagger';

/** Platform-operator view of a buyer, with the shop they belong to. */
export class PlatformCustomerResponse {
  @ApiProperty() id!: string;
  @ApiProperty() name!: string;
  @ApiProperty() email!: string;
  @ApiProperty({ example: 'Dhaka' }) city!: string;
  @ApiProperty({ example: 'VIP' }) segment!: string;
  @ApiProperty({ example: 4 }) ordersCount!: number;
  /** Lifetime spend in the shop's currency (major units). */
  @ApiProperty({ example: 12990 }) spent!: number;
  @ApiProperty({ description: 'Shop this buyer ordered from' })
  shopName!: string;
  @ApiProperty() shopHandle!: string;
  @ApiProperty({ example: 'BDT' }) currency!: string;
  @ApiProperty() createdAt!: string;
}

/** Paginated platform-admin customer list. `total` counts the filtered set. */
export class PlatformCustomerListResponse {
  @ApiProperty({ type: [PlatformCustomerResponse] })
  data!: PlatformCustomerResponse[];
  @ApiProperty() total!: number;
  @ApiProperty() page!: number;
  @ApiProperty() limit!: number;
}
