import { ApiProperty } from '@nestjs/swagger';
import { IsString, MaxLength, MinLength } from 'class-validator';

/** Complete an emailed invite: set up the console account and sign in. */
export class AcceptInviteDto {
  @ApiProperty({ example: 'Rafi Ahmed' })
  @IsString()
  @MinLength(2, { message: 'Name must be at least 2 characters' })
  @MaxLength(160)
  name!: string;

  @ApiProperty({ example: 'sup3rsecret', minLength: 6 })
  @IsString()
  @MinLength(6, { message: 'Password must be at least 6 characters' })
  @MaxLength(128)
  password!: string;
}
