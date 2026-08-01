import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsEmail,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  MaxLength,
  MinLength,
} from 'class-validator';

/** Stage 1 of admin login — workspace + credentials. */
export class AdminLoginDto {
  @ApiProperty({
    example: 'mango-shop',
    description: 'Shop handle (workspace) — hoomri.com/admin/<workspace>',
  })
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  workspace!: string;

  @ApiProperty({ example: 'maya@mango-shop.com' })
  @IsEmail({}, { message: 'Enter a valid email address' })
  @MaxLength(254)
  email!: string;

  @ApiProperty({ example: 'sup3rsecret' })
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  password!: string;
}

/** Seller→admin elevation / shop switch — optionally pick which owned shop. */
export class AdminSessionDto {
  @ApiPropertyOptional({
    description: 'Owned shop to open. Omit to use the most recent shop.',
  })
  @IsOptional()
  @IsUUID()
  shopId?: string;
}

/** Stage 2 of admin login — TOTP verification against the issued ticket. */
export class AdminTwoFactorDto {
  @ApiProperty({ description: 'Ticket returned by /auth/admin/login' })
  @IsString()
  @MinLength(1)
  ticket!: string;

  @ApiProperty({ example: '123456', description: '6-digit TOTP code' })
  @IsString()
  @Length(6, 6, { message: 'Code must be 6 digits' })
  code!: string;
}
