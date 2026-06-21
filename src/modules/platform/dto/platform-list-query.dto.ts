import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength } from 'class-validator';
import { PaginationQueryDto } from '../../../common/dto/pagination-query.dto';

/** Paginated list query for the platform-admin shop/customer tables. */
export class PlatformListQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ description: 'Search by name / handle / email' })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  q?: string;
}
