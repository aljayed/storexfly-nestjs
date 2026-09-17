import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';
import { PaginationQueryDto } from '../../../common/dto/pagination-query.dto';
import { customerSegmentEnum } from '../../../database/schema/enums';

type CustomerSegment = (typeof customerSegmentEnum.enumValues)[number];

export class CustomerQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ enum: customerSegmentEnum.enumValues })
  @IsOptional()
  @IsEnum(customerSegmentEnum.enumValues)
  segment?: CustomerSegment;

  @ApiPropertyOptional({ description: 'Search name / email / city' })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  q?: string;
}

export const LIST_SORTS = ['spent', 'recent', 'orders'] as const;
export type CustomerListSort = (typeof LIST_SORTS)[number];

/** Days without an order after which a repeat buyer counts as gone quiet. */
export const QUIET_AFTER_DAYS = 60;

/** The customer list: the shared filters plus its own order and win-back filter. */
export class CustomerListQueryDto extends CustomerQueryDto {
  @ApiPropertyOptional({ enum: LIST_SORTS, default: 'spent' })
  @IsOptional()
  @IsIn(LIST_SORTS)
  sort: CustomerListSort = 'spent';

  @ApiPropertyOptional({
    description: `Only repeat buyers with no order in ${QUIET_AFTER_DAYS}+ days, longest gone first.`,
  })
  @IsOptional()
  @Transform(({ value }) => value === true || value === 'true' || value === '1')
  @IsBoolean()
  quiet?: boolean;
}
