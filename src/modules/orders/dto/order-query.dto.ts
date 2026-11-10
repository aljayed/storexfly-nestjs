import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsOptional, IsString, MaxLength } from 'class-validator';
import { PaginationQueryDto } from '../../../common/dto/pagination-query.dto';
import {
  orderStatusEnum,
  salesChannelEnum,
} from '../../../database/schema/enums';

type OrderStatus = (typeof orderStatusEnum.enumValues)[number];
type SalesChannel = (typeof salesChannelEnum.enumValues)[number];

export const ORDER_SORTS = ['newest', 'oldest', 'total'] as const;
export type OrderSort = (typeof ORDER_SORTS)[number];

export const ORDER_MODES = ['retail', 'reseller', 'wholesale', 'trade'] as const;
export type OrderModeFilter = (typeof ORDER_MODES)[number];

export class OrderQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ enum: orderStatusEnum.enumValues })
  @IsOptional()
  @IsEnum(orderStatusEnum.enumValues)
  status?: OrderStatus;

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
