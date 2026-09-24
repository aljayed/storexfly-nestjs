import { ApiProperty } from '@nestjs/swagger';
import { IsString, Matches, MaxLength, MinLength } from 'class-validator';

/** A shop on a temporary link choosing its real one. Same rules as opening. */
export class ChooseHandleDto {
  @ApiProperty({ example: 'mango-shop', description: 'URL handle' })
  @IsString()
  @Matches(/^[a-z0-9-]+$/, {
    message: 'Handle may only contain lowercase letters, numbers and hyphens',
  })
  @MinLength(2)
  @MaxLength(80)
  handle!: string;
}
