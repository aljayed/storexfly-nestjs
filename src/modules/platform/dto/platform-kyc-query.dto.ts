import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import { PaginationQueryDto } from '../../../common/dto/pagination-query.dto';

/** A `status` filter for the review queue. `all` shows every submitted shop. */
export type KycStatusFilter =
  | 'all'
  | 'pending'
  | 'verified'
  | 'rejected'
  | 'unsubmitted';

/** Paginated, status-filtered query for the platform-admin KYC review queue. */
export class PlatformKycQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({
    enum: ['all', 'pending', 'verified', 'rejected', 'unsubmitted'],
    description: 'Filter by review status (default: all submitted)',
  })
  @IsOptional()
  @IsIn(['all', 'pending', 'verified', 'rejected', 'unsubmitted'])
  status?: KycStatusFilter;

  @ApiPropertyOptional({
    description: 'Search by shop name / handle / legal name',
  })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  q?: string;
}

/** Operator's verdict on a submission: approve or reject. */
export class KycDecisionDto {
  @ApiProperty({ enum: ['verified', 'rejected'] })
  @IsIn(['verified', 'rejected'])
  status!: 'verified' | 'rejected';
}
