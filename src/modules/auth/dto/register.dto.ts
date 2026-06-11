import { ApiProperty } from '@nestjs/swagger';
import {
  IsEmail,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';

/** Seller registration (email path). Validation mirrors the prototype's form. */
export class RegisterDto {
  @ApiProperty({ example: 'Maya Kapoor' })
  @IsString()
  @MinLength(2, { message: 'Name must be at least 2 characters' })
  @MaxLength(160)
  name!: string;

  @ApiProperty({ example: 'maya@example.com' })
  @IsEmail({}, { message: 'Enter a valid email address' })
  @MaxLength(320)
  email!: string;

  @ApiProperty({ example: 'sup3rsecret', minLength: 6 })
  @IsString()
  @MinLength(6, { message: 'Password must be at least 6 characters' })
  @MaxLength(128)
  password!: string;
}
