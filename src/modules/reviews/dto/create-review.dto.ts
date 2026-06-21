import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
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
  image?: string;
}

/** Whether the signed-in buyer may review this product. */
export class ReviewEligibilityResponse {
  @ApiProperty() purchased!: boolean;
  @ApiProperty() alreadyReviewed!: boolean;
  // The id of the buyer's existing review, so the client can offer edit/delete.
  @ApiProperty({ nullable: true }) reviewId!: string | null;
}
