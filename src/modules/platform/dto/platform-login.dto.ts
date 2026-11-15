import { ApiProperty } from '@nestjs/swagger';
import {
  IsEmail,
  IsNotEmpty,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';

export class PlatformLoginDto {
  @ApiProperty({ example: 'admin@hoomri.com' })
  @IsEmail()
  @MaxLength(254)
  email!: string;

  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  password!: string;
}

export class PlatformCodeDto {
  @ApiProperty({ description: 'Ticket from the previous sign-in step' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(2000)
  ticket!: string;

  @ApiProperty({ example: '123456' })
  @IsString()
  @Matches(/^\d{6}$/, { message: 'Enter the 6-digit code from your app' })
  code!: string;
}

export class PlatformNewPasswordDto {
  @ApiProperty({ description: 'Ticket from the previous sign-in step' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(2000)
  ticket!: string;

  @ApiProperty()
  @IsString()
  @MinLength(10, { message: 'Use at least 10 characters' })
  @MaxLength(128)
  password!: string;
}

export class PlatformChangePasswordDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  currentPassword!: string;

  @ApiProperty()
  @IsString()
  @MinLength(10, { message: 'Use at least 10 characters' })
  @MaxLength(128)
  newPassword!: string;
}
