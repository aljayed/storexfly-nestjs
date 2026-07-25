import { ApiProperty } from '@nestjs/swagger';
import { IsString, Length } from 'class-validator';

/** A 6-digit OTP code the signed-in buyer submits (e.g. verifying their email). */
export class VerifyCodeDto {
  @ApiProperty({ example: '123456' })
  @IsString()
  @Length(6, 6, { message: 'Enter the 6-digit code' })
  code!: string;
}
