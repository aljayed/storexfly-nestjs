import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsOptional, IsString, Length } from 'class-validator';

export class DeleteShopDto {
  @ApiProperty({
    example: '482913',
    description: 'The 6-digit confirmation code emailed to the shop owner',
  })
  @IsString()
  @Length(6, 6)
  code!: string;

  @ApiPropertyOptional({
    example: true,
    description:
      'The seller has seen the unused sales credit this shop still holds and accepts that deleting it forfeits that credit. Required when the balance is above zero.',
  })
  @IsOptional()
  @IsBoolean()
  creditAcknowledged?: boolean;
}
