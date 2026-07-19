import { ApiProperty } from '@nestjs/swagger';
import { CustomerResponse } from './customer.response';

/** One month column of the activity matrix ("2026-07" → "Jul 2026"). */
export class ActivityMonthResponse {
  @ApiProperty({ description: 'Bucket key, "YYYY-MM"' }) key!: string;
  @ApiProperty({ description: 'Short month name, e.g. "Jul"' }) label!: string;
  @ApiProperty() year!: number;
}

/** A product bought within one customer × month cell. */
export class ActivityProductResponse {
  @ApiProperty({ description: 'Name as sold (denormalized at purchase time)' })
  name!: string;
  @ApiProperty() qty!: number;
}

/** One filled cell: what a customer bought in one month. */
export class ActivityCellResponse {
  @ApiProperty({ description: 'Orders placed that month' }) orders!: number;
  @ApiProperty({ description: 'Spend that month (dollars)' }) spent!: number;
  @ApiProperty({ type: [ActivityProductResponse] })
  products!: ActivityProductResponse[];
}

/** One matrix row: a customer plus their per-month cells (sparse). */
export class CustomerActivityRowResponse {
  @ApiProperty({ type: CustomerResponse }) customer!: CustomerResponse;
  @ApiProperty({ description: 'Orders inside the window' })
  windowOrders!: number;
  @ApiProperty({ description: 'Spend inside the window (dollars)' })
  windowSpent!: number;
  @ApiProperty({ description: 'Distinct months with at least one order' })
  activeMonths!: number;
  @ApiProperty({
    description: 'Month key → cell; months without orders are absent',
  })
  cells!: Record<string, ActivityCellResponse>;
}

/** Shop-wide per-month totals for the matrix footer (ignore filters). */
export class ActivityMonthTotalsResponse {
  @ApiProperty({ description: 'Distinct buying customers that month' })
  customers!: number;
  @ApiProperty() orders!: number;
  @ApiProperty({ description: 'Revenue that month (dollars)' })
  revenue!: number;
}

/** Paginated month-wise activity matrix for the admin Customers page. */
export class MonthlyActivityResponse {
  @ApiProperty({ type: [ActivityMonthResponse] })
  months!: ActivityMonthResponse[];
  @ApiProperty({ type: [CustomerActivityRowResponse] })
  data!: CustomerActivityRowResponse[];
  @ApiProperty({ description: 'Month key → shop-wide totals' })
  totals!: Record<string, ActivityMonthTotalsResponse>;
  @ApiProperty({ description: 'Customers matching the filters (all pages)' })
  total!: number;
  @ApiProperty() page!: number;
  @ApiProperty() limit!: number;
}
