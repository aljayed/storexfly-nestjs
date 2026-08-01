import { ApiProperty } from '@nestjs/swagger';
import { IsBoolean } from 'class-validator';

export class SetAutoResetDto {
  @ApiProperty({
    description:
      'Start every billing period on the entry plan, letting auto-scale climb again as sales come in. Requires auto-scale.',
  })
  @IsBoolean()
  enabled!: boolean;
}
