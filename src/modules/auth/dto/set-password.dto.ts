import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

/**
 * Set or change the signed-in account's password. `currentPassword` is only
 * required when the account already has one - an account created through
 * Google has none to prove, and the session it is already holding is what
 * stands in for it.
 */
export class SetPasswordDto {
  @ApiPropertyOptional({
    description: 'Required only when the account already has a password.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(128)
  currentPassword?: string;

  @ApiProperty({ example: 'sup3rsecret', minLength: 6 })
  @IsString()
  @MinLength(6, { message: 'Password must be at least 6 characters' })
  @MaxLength(128)
  password!: string;
}
