import { ApiProperty } from '@nestjs/swagger';
import { OrderResponse } from './order.response';

/** Shop-wide aggregates (ignore filters) so KPI cards and the status tab
    counts stay correct no matter which page or filter is active. */
export class OrderListStatsResponse {
  @ApiProperty({ description: 'Orders per status, plus "All"' })
  counts!: Record<string, number>;
  @ApiProperty({ description: 'Lifetime revenue, paid orders (major units)' })
  revenue!: number;
  @ApiProperty({ description: 'Average paid order value (major units)' })
  avgOrderValue!: number;
  @ApiProperty() refunded!: number;
}

/** Paginated admin order list. `total` counts rows matching the filters. */
export class OrderListResponse {
  @ApiProperty({ type: [OrderResponse] }) data!: OrderResponse[];
  @ApiProperty() total!: number;
  @ApiProperty() page!: number;
  @ApiProperty() limit!: number;
  @ApiProperty({ type: OrderListStatsResponse }) stats!: OrderListStatsResponse;
}
