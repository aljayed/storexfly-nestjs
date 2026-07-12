import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsEmail, IsString, Length, MaxLength } from 'class-validator';

const lower = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim().toLowerCase() : value;

/** Completes a blocking email-OTP signup flow (seller register or buyer signup). */
export class EmailOtpVerifyDto {
  @ApiProperty({ example: 'maya@example.com' })
  @IsEmail({}, { message: 'Enter a valid email address' })
  @Transform(lower)
  @MaxLength(320)
  email!: string;

  @ApiProperty({ example: '123456' })
  @IsString()
  @Length(6, 6, { message: 'Enter the 6-digit code' })
  code!: string;
}
