import { ApiProperty } from '@nestjs/swagger';
import { IsBoolean } from 'class-validator';

export class SetAutoScaleDto {
  @ApiProperty({
    description:
      'Move up one plan automatically when sales reach 100% of the current cap',
  })
  @IsBoolean()
  enabled!: boolean;
}
