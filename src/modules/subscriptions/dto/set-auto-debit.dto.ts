import { ApiProperty } from '@nestjs/swagger';
import { IsBoolean } from 'class-validator';

export class SetAutoDebitDto {
  @ApiProperty({ description: 'Collect renewals automatically on the due date' })
  @IsBoolean()
  enabled!: boolean;
}
