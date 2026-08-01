import { ApiProperty } from '@nestjs/swagger';
import { IsEmail, IsString, Length, Matches, MaxLength } from 'class-validator';

/** Proving a phone number on the signed-in account (shop-creation gate). */
export class VerifyPhoneStartDto {
  @ApiProperty({ example: '+8801712345678', description: 'E.164 phone number' })
  @IsString()
  @Matches(/^\+?[0-9]{6,18}$/, { message: 'Enter a valid phone number' })
  phone!: string;
}

export class VerifyPhoneConfirmDto extends VerifyPhoneStartDto {
  @ApiProperty({ example: '123456' })
  @IsString()
  @Length(6, 6)
  code!: string;
}

/** Proving an email address on the signed-in account (shop-creation gate). */
export class VerifyEmailStartDto {
  @ApiProperty({ example: 'seller@example.com' })
  @IsEmail()
  @MaxLength(254)
  email!: string;
}

export class VerifyEmailConfirmDto extends VerifyEmailStartDto {
  @ApiProperty({ example: '123456' })
  @IsString()
  @Length(6, 6)
  code!: string;
}
