import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsOptional, IsString, Matches, MaxLength } from 'class-validator';

/**
 * Seller-submitted business verification (trade-licence KYC). Every field is
 * optional so a seller can save partial details and finish later, or submit
 * the document on its own. `document` is the trade licence as a data URL
 * (image or PDF), capped to comfortably fit the 15mb JSON body limit.
 *
 * Used both as an optional block on the create-shop wizard and as the body of
 * `PATCH /shops/:id/kyc` from the seller console.
 */
export class SubmitKycDto {
  @ApiPropertyOptional({ example: 'Mango Fresh Trading' })
  @IsOptional()
  @IsString()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @MaxLength(200)
  legalName?: string;

  @ApiPropertyOptional({ example: 'TRAD/DSCC/123456' })
  @IsOptional()
  @IsString()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @MaxLength(120)
  licenseNo?: string;

  @ApiPropertyOptional({
    description: 'Trade licence document as a data URL (image or PDF)',
    example: 'data:application/pdf;base64,…',
  })
  @IsOptional()
  @IsString()
  // Strict shape check: this string is later rendered in the platform-admin
  // console, so only base64 image/PDF data URLs are ever accepted — never
  // markup or other URL schemes.
  @Matches(
    /^data:(image\/(png|jpeg|jpg|webp)|application\/pdf);base64,[A-Za-z0-9+/]+=*$/,
    {
      message: 'document must be a base64 image or PDF data URL',
    },
  )
  @MaxLength(10_000_000)
  document?: string;
}
