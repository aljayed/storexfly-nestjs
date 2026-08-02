import { ApiProperty } from '@nestjs/swagger';
import { IsIn } from 'class-validator';

export class SetBillingModeDto {
  @ApiProperty({
    enum: ['credits', 'commission'],
    description:
      'Which track to pay on. "commission" needs a verified trade licence.',
  })
  @IsIn(['credits', 'commission'])
  mode!: 'credits' | 'commission';
}
