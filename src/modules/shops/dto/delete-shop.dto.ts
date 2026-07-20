import { ApiProperty } from '@nestjs/swagger';
import { IsString, Length } from 'class-validator';

export class DeleteShopDto {
  @ApiProperty({
    example: '482913',
    description: 'The 6-digit confirmation code emailed to the shop owner',
  })
  @IsString()
  @Length(6, 6)
  code!: string;
}
