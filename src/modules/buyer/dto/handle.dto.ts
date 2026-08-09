import { ApiProperty } from '@nestjs/swagger';
import { IsString, MaxLength, MinLength } from 'class-validator';
import { Transform } from 'class-transformer';

// Length is checked loosely here and precisely in handle.util, which owns the
// rules: this only keeps absurd payloads out of the service.
const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

export class CheckHandleDto {
  @ApiProperty({ example: 'rafiq' })
  @IsString()
  @Transform(trim)
  @MinLength(1)
  @MaxLength(40)
  handle!: string;
}

export class SetHandleDto extends CheckHandleDto {}
