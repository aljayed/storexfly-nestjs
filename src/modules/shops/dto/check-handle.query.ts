import { ApiProperty } from '@nestjs/swagger';
import { IsString, MaxLength, MinLength } from 'class-validator';

export class CheckHandleQuery {
  @ApiProperty({ example: 'mango-shop' })
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  handle!: string;
}
