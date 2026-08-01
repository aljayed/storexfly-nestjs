import { ApiProperty } from '@nestjs/swagger';
import { IsString, Length } from 'class-validator';

/** Move the shop to another rung of the plan ladder. */
export class ChangePlanDto {
  @ApiProperty({
    example: 'growth',
    description:
      'Plan code. A dearer plan starts immediately (prorated); a cheaper one waits for the paid-up period to end.',
  })
  @IsString()
  @Length(1, 32)
  code!: string;
}
