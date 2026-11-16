import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import { PaginationQueryDto } from '../../../common/dto/pagination-query.dto';
import {
  orderStatusEnum,
  salesChannelEnum,
} from '../../../database/schema/enums';

type OrderStatus = (typeof orderStatusEnum.enumValues)[number];
type SalesChannel = (typeof salesChannelEnum.enumValues)[number];

/**
 * The stages where the next move is the seller's: confirm it, pack it, hand
 * it to the courier. Past that the parcel is the courier's, and Delivered /
 * Cancelled / Exchanged are finished - none of those need the seller.
 */
export const PENDING_ORDER_STATUSES = [
  'New',
  'Confirmed',
  'Packed',
] as const satisfies readonly OrderStatus[];
/** `Pending` is a filter over {@link PENDING_ORDER_STATUSES}, not a status. */
export type OrderStatusFilter = OrderStatus | 'Pending';

export const ORDER_SORTS = ['newest', 'oldest', 'total'] as const;
export type OrderSort = (typeof ORDER_SORTS)[number];

export const ORDER_MODES = ['retail', 'reseller', 'wholesale', 'trade'] as const;
export type OrderModeFilter = (typeof ORDER_MODES)[number];

export class OrderQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({
    enum: [...orderStatusEnum.enumValues, 'Pending'],
    description:
      'One status, or `Pending` for every order still waiting on the seller (New, Confirmed, Packed).',
  })
  @IsOptional()
  @IsIn([...orderStatusEnum.enumValues, 'Pending'])
  status?: OrderStatusFilter;

  @ApiPropertyOptional({ enum: salesChannelEnum.enumValues })
  @IsOptional()
  @IsEnum(salesChannelEnum.enumValues)
  channel?: SalesChannel;

  @ApiPropertyOptional({ description: 'Search reference / customer / email' })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  q?: string;

  /** Which selling channel: one mode, or `trade` for reseller + wholesale. */
  @ApiPropertyOptional({ enum: ORDER_MODES })
  @IsOptional()
  @IsEnum(ORDER_MODES)
  commerceMode?: OrderModeFilter;

  @ApiPropertyOptional({ enum: ORDER_SORTS, default: 'newest' })
  @IsOptional()
  @IsEnum(ORDER_SORTS)
  sort?: OrderSort;
}
