import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

/** A buyer's review submission for a product they purchased. */
export class CreateReviewDto {
  @ApiProperty({ example: 5, minimum: 1, maximum: 5 })
  @IsInt()
  @Min(1)
  @Max(5)
  rating!: number;

  @ApiPropertyOptional({ example: 'Great quality, fast delivery!' })
  @IsOptional()
  @IsString()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @MaxLength(2000)
  body?: string;

  @ApiPropertyOptional({ description: 'Optional photo as an image data URL' })
  @IsOptional()
  @IsString()
  @Matches(/^data:image\//, { message: 'image must be an image data URL' })
  // ~2 MB of base64 - reviews render on the public product page, so an
  // unbounded string would be an amplification vector for every visitor.
  @MaxLength(3_000_000)
  image?: string;
}

/** Whether the signed-in buyer may review this product. */
export class ReviewEligibilityResponse {
  @ApiProperty() purchased!: boolean;
  @ApiProperty() alreadyReviewed!: boolean;
  // The id of the buyer's existing review, so the client can offer edit/delete.
  @ApiProperty({ nullable: true }) reviewId!: string | null;
}

/** The shop's public answer to a review. */
export class ReviewReplyDto {
  @ApiProperty({ maxLength: 1000 })
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @Matches(/\S/, { message: 'Write a reply first' })
  @MaxLength(1000)
  body!: string;
}

/** Which reviews the seller console lists. */
export class ShopReviewsQuery {
  @ApiPropertyOptional({ enum: ['all', 'unreplied', 'critical'] })
  @IsOptional()
  @IsIn(['all', 'unreplied', 'critical'])
  filter?: 'all' | 'unreplied' | 'critical';

  @ApiPropertyOptional()
  @IsOptional()
  @Transform(({ value }: { value: unknown }) => Number(value))
  @IsInt()
  @Min(0)
  cursor?: number;
}
