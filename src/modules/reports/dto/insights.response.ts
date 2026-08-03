import { ApiProperty } from '@nestjs/swagger';

/**
 * The seller-console insights report. Every section is derived from the same
 * set of orders in one pass, so the numbers on different tabs always
 * reconcile with each other.
 *
 * Money semantics, applied identically everywhere in this payload:
 *   - `Pending` orders (a gateway payment still in flight, auto-expiring and
 *     hidden from the seller pipeline) are excluded from every figure. They
 *     are not sales yet, and counting them would inflate every KPI.
 *   - `netSales` = `collected` + `outstanding` - the live book of a period.
 *   - `collected` is money confirmed in hand (`pay = Paid`).
 *   - `outstanding` is accepted but uncollected (`pay = Due`) - for a COD
 *     shop this is cash sitting with the courier, the number that decides
 *     whether a good month is actually a good month.
 *   - `cancelled` and `refunded` are reported as leaks, never netted in.
 */

export class ReportRangeResponse {
  @ApiProperty({ description: 'Window start (ISO date)' }) from!: string;
  @ApiProperty({ description: 'Window end, inclusive (ISO date)' }) to!: string;
  @ApiProperty({ description: 'Preceding comparison window start (ISO date)' })
  prevFrom!: string;
  @ApiProperty({ description: 'Preceding comparison window end (ISO date)' })
  prevTo!: string;
  @ApiProperty({ description: 'Window length in days' }) days!: number;
  @ApiProperty({ enum: ['hour', 'day', 'month'] })
  granularity!: 'hour' | 'day' | 'month';
}

export class SalesPointResponse {
  @ApiProperty({ example: '14 Jun' }) label!: string;
  @ApiProperty({ description: 'Bucket start (ISO datetime)' }) from!: string;
  @ApiProperty({ description: 'Bucket end, exclusive (ISO datetime)' })
  to!: string;
  @ApiProperty() netSales!: number;
  @ApiProperty() collected!: number;
  @ApiProperty() orders!: number;
}

export class SalesInsightResponse {
  @ApiProperty({ description: 'collected + outstanding' }) netSales!: number;
  @ApiProperty({ description: 'Money confirmed received' }) collected!: number;
  @ApiProperty({ description: 'Accepted but not yet collected (COD in flight)' })
  outstanding!: number;
  @ApiProperty({ description: 'Value of orders cancelled in the window' })
  cancelled!: number;
  @ApiProperty() refunded!: number;
  @ApiProperty() orders!: number;
  @ApiProperty() cancelledOrders!: number;
  @ApiProperty() unitsSold!: number;
  @ApiProperty() avgOrderValue!: number;
  @ApiProperty({ description: 'Delivery fees charged to buyers' })
  deliveryCharged!: number;
  @ApiProperty({ description: 'Discounts given away' }) discountGiven!: number;
  @ApiProperty({ description: 'Distinct buyers who ordered in the window' })
  buyers!: number;

  // Preceding window of equal length, for period-over-period deltas.
  @ApiProperty() prevNetSales!: number;
  @ApiProperty() prevCollected!: number;
  @ApiProperty() prevOrders!: number;
  @ApiProperty() prevAvgOrderValue!: number;

  @ApiProperty({ type: [SalesPointResponse] }) series!: SalesPointResponse[];
}

export class FunnelStageResponse {
  @ApiProperty({ example: 'Confirmed' }) stage!: string;
  @ApiProperty({ description: 'Orders that reached this stage' })
  orders!: number;
  @ApiProperty({ description: 'Their value' }) value!: number;
  @ApiProperty({ description: 'Share of placed orders, 0-100' })
  pctOfPlaced!: number;
  @ApiProperty({ description: 'Orders lost between the previous stage and this' })
  droppedFromPrevious!: number;
}

export class PipelineStageResponse {
  @ApiProperty({ example: 'New' }) status!: string;
  @ApiProperty() orders!: number;
  @ApiProperty() value!: number;
  @ApiProperty({ description: 'Age of the oldest order in this stage, in days' })
  oldestDays!: number;
  @ApiProperty({ description: 'Orders sitting here past the stage target' })
  overdue!: number;
  @ApiProperty({ description: 'Days an order should spend here at most' })
  targetDays!: number;
}

export class FulfilmentInsightResponse {
  @ApiProperty({ type: [FunnelStageResponse] }) funnel!: FunnelStageResponse[];
  @ApiProperty({ description: 'Reached Confirmed or beyond, 0-100' })
  confirmRate!: number;
  @ApiProperty({ description: 'Reached Delivered, 0-100' }) deliveryRate!: number;
  @ApiProperty({ description: 'Cancelled, 0-100' }) cancelRate!: number;
  @ApiProperty() prevConfirmRate!: number;
  @ApiProperty() prevDeliveryRate!: number;
  @ApiProperty() prevCancelRate!: number;
  @ApiProperty({
    description: 'Share of packed-or-later orders handed to a courier, 0-100',
  })
  courierBookedRate!: number;
  @ApiProperty({
    description: 'Live open pipeline - current state, not window-scoped',
    type: [PipelineStageResponse],
  })
  pipeline!: PipelineStageResponse[];
}

export class PaymentSplitResponse {
  @ApiProperty({ example: 'cod' }) code!: string;
  @ApiProperty({ example: 'Cash on Delivery' }) label!: string;
  @ApiProperty() orders!: number;
  @ApiProperty() netSales!: number;
  @ApiProperty() collected!: number;
  @ApiProperty() outstanding!: number;
  @ApiProperty({ description: 'Share of net sales, 0-100' }) share!: number;
  @ApiProperty({ description: 'Cancellation rate for this method, 0-100' })
  cancelRate!: number;
}

export class ChannelSplitResponse {
  @ApiProperty({ example: 'Instagram' }) channel!: string;
  @ApiProperty() orders!: number;
  @ApiProperty() netSales!: number;
  @ApiProperty() avgOrderValue!: number;
  @ApiProperty({ description: 'Share of net sales, 0-100' }) share!: number;
  @ApiProperty({ description: 'Cancellation rate for this channel, 0-100' })
  cancelRate!: number;
}

export class CouponUseResponse {
  @ApiProperty({ example: 'EID20' }) code!: string;
  @ApiProperty() orders!: number;
  @ApiProperty({ description: 'Discount given away through this code' })
  discount!: number;
  @ApiProperty({ description: 'Net sales on orders that used it' })
  netSales!: number;
  @ApiProperty() avgOrderValue!: number;
}

export class DiscountInsightResponse {
  @ApiProperty() discountedOrders!: number;
  @ApiProperty() discountGiven!: number;
  @ApiProperty({
    description: 'Discount as a share of what those orders would have been, 0-100',
  })
  discountRate!: number;
  @ApiProperty({ description: 'Average value of a discounted order' })
  avgDiscountedOrder!: number;
  @ApiProperty({ description: 'Average value of a full-price order' })
  avgFullPriceOrder!: number;
  @ApiProperty({ type: [CouponUseResponse] }) coupons!: CouponUseResponse[];
}

export class AreaSplitResponse {
  @ApiProperty({ example: 'Dhanmondi' }) area!: string;
  @ApiProperty() orders!: number;
  @ApiProperty() netSales!: number;
  @ApiProperty() avgOrderValue!: number;
  @ApiProperty({ description: 'Cancellation rate for this area, 0-100' })
  cancelRate!: number;
}

export class ProductInsightResponse {
  @ApiProperty() name!: string;
  @ApiProperty() units!: number;
  @ApiProperty() orders!: number;
  @ApiProperty({ description: 'Distinct buyers who ordered it' })
  buyers!: number;
  @ApiProperty({ description: 'Buyers who ordered it in two or more orders' })
  repeatBuyers!: number;
  @ApiProperty({ description: 'repeatBuyers / buyers, 0-100' })
  repeatRate!: number;
  @ApiProperty() revenue!: number;
  @ApiProperty({ description: 'Share of product revenue in the window, 0-100' })
  revenueShare!: number;
  @ApiProperty({ description: 'Orders containing it that were cancelled' })
  cancelledOrders!: number;
  @ApiProperty({ description: 'cancelledOrders / (orders + cancelled), 0-100' })
  cancelRate!: number;
  @ApiProperty() averageUnitsPerOrder!: number;
  @ApiProperty({ description: 'Last time it was ordered (ISO datetime)' })
  lastOrdered!: string;
}

export class ProductsInsightResponse {
  @ApiProperty({ type: [ProductInsightResponse] })
  rows!: ProductInsightResponse[];
  @ApiProperty({ description: 'Total product revenue in the window' })
  totalRevenue!: number;
  @ApiProperty({ description: 'How many products make up 80% of revenue' })
  paretoCount!: number;
  @ApiProperty({ description: 'What those products actually add up to, 0-100' })
  paretoShare!: number;
}

export class InsightsResponse {
  @ApiProperty({ type: ReportRangeResponse }) range!: ReportRangeResponse;
  @ApiProperty({ type: SalesInsightResponse }) sales!: SalesInsightResponse;
  @ApiProperty({ type: FulfilmentInsightResponse })
  fulfilment!: FulfilmentInsightResponse;
  @ApiProperty({ type: [PaymentSplitResponse] })
  payments!: PaymentSplitResponse[];
  @ApiProperty({ type: [ChannelSplitResponse] })
  channels!: ChannelSplitResponse[];
  @ApiProperty({ type: DiscountInsightResponse })
  discounts!: DiscountInsightResponse;
  @ApiProperty({ type: [AreaSplitResponse] }) areas!: AreaSplitResponse[];
  @ApiProperty({ type: ProductsInsightResponse })
  products!: ProductsInsightResponse;
}
