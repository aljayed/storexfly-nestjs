import { ApiProperty } from '@nestjs/swagger';

export class RevenuePointResponse {
  @ApiProperty({ example: 'Jun' }) label!: string;
  @ApiProperty({ example: 2980, description: 'Revenue (dollars)' })
  value!: number;
}

/**
 * Dashboard KPIs + revenue series for the selected window. Range-scoped
 * figures (`revenue`, `orders`, …) cover [rangeFrom, rangeTo]; the `prev*`
 * pair covers the preceding window of equal length so the UI can show real
 * period-over-period deltas. The series is bucketed per day for windows up
 * to ~2 months and per month beyond that.
 */
export class DashboardResponse {
  // Always-current snapshot (independent of the selected range).
  @ApiProperty({ description: "Today's revenue (dollars)" })
  revenueToday!: number;
  @ApiProperty() ordersToday!: number;
  @ApiProperty({ description: 'Lifetime repeat-buyer rate, 0–100' })
  repeatBuyerRate!: number;

  // Selected-range figures.
  @ApiProperty({ description: 'Range start (ISO date)' }) rangeFrom!: string;
  @ApiProperty({ description: 'Range end (ISO date)' }) rangeTo!: string;
  @ApiProperty({ description: 'Revenue in range (dollars)' }) revenue!: number;
  @ApiProperty({ description: 'Paid orders in range' }) orders!: number;
  @ApiProperty({ description: 'Units sold in range' }) unitsSold!: number;
  @ApiProperty({ description: 'Average order value in range (dollars)' })
  avgOrderValue!: number;

  // Preceding window of equal length, for deltas.
  @ApiProperty({ description: 'Revenue in the previous window (dollars)' })
  prevRevenue!: number;
  @ApiProperty({ description: 'Paid orders in the previous window' })
  prevOrders!: number;

  @ApiProperty({ enum: ['day', 'month'] }) granularity!: 'day' | 'month';
  @ApiProperty({ type: [RevenuePointResponse] })
  revenueSeries!: RevenuePointResponse[];
}
