import { ApiProperty } from '@nestjs/swagger';
import { IsString, Length, Matches } from 'class-validator';

export class PhoneStartDto {
  @ApiProperty({ example: '+8801712345678', description: 'E.164 phone number' })
  @IsString()
  @Matches(/^\+?[0-9]{6,18}$/, { message: 'Enter a valid phone number' })
  phone!: string;
}

export class PhoneVerifyDto {
  @ApiProperty({ example: '+8801712345678' })
  @IsString()
  @Matches(/^\+?[0-9]{6,18}$/, { message: 'Enter a valid phone number' })
  phone!: string;

  @ApiProperty({ example: '1234', description: '4-digit OTP code' })
  @IsString()
  @Length(4, 6)
  code!: string;
}
