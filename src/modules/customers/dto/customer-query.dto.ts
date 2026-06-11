import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsOptional, IsString, MaxLength } from 'class-validator';
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
