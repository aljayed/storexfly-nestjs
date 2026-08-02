import { ApiProperty } from '@nestjs/swagger';
import { CustomerResponse } from '../../customers/dto/customer.response';

/** Repeat-buyer aggregation (Reports view). */
export class RepeatBuyersResponse {
  @ApiProperty() totalCustomers!: number;
  @ApiProperty() repeatCustomers!: number;
  @ApiProperty({ description: 'Repeat rate, 0-100' }) repeatRate!: number;
  @ApiProperty({ description: 'Average orders per repeat buyer' })
  avgOrdersPerRepeatBuyer!: number;
  @ApiProperty({ type: [CustomerResponse] })
  buyers!: CustomerResponse[];
}
