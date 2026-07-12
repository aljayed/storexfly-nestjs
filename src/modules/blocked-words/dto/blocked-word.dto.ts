import { ApiProperty } from '@nestjs/swagger';
import { IsString, Matches, MaxLength, MinLength } from 'class-validator';

export class CreateBlockedWordDto {
  @ApiProperty({ example: 'hoomri' })
  @IsString()
  @MinLength(2)
  @MaxLength(80)
  @Matches(/^[a-z0-9 '-]+$/i, {
    message: 'Only letters, numbers, spaces, apostrophes and hyphens are allowed',
  })
  word!: string;
}
