import { ApiProperty } from '@nestjs/swagger';
import { CustomerResponse } from './customer.response';

/** Shop-wide aggregates (ignore filters) for the page header + segment tabs. */
export class CustomerListStatsResponse {
  @ApiProperty({ description: 'Customers per segment, plus "All"' })
  counts!: Record<string, number>;
  @ApiProperty({ description: 'Customers with more than one order' })
  returning!: number;
  @ApiProperty({ description: 'Average lifetime spend (major units)' })
  avgLifetime!: number;
}

/** Paginated admin customer list. `total` counts rows matching the filters. */
export class CustomerListResponse {
  @ApiProperty({ type: [CustomerResponse] }) data!: CustomerResponse[];
  @ApiProperty() total!: number;
  @ApiProperty() page!: number;
  @ApiProperty() limit!: number;
  @ApiProperty({ type: CustomerListStatsResponse })
  stats!: CustomerListStatsResponse;
}
