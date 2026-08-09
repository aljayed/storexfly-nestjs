import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import type { UserRow } from '../../../database/schema';

/** Public-facing user shape (the `User` interface from the design handoff). */
export class UserResponse {
  @ApiProperty() id!: string;
  @ApiProperty() name!: string;
  @ApiPropertyOptional() email?: string;
  @ApiPropertyOptional() phone?: string;
  @ApiProperty({ enum: ['email', 'google', 'phone'] })
  via!: 'email' | 'google' | 'phone';
  @ApiPropertyOptional() isAdmin?: boolean;
  // Shop creation needs both proven - the console reads them off /auth/me.
  @ApiProperty() emailVerified!: boolean;
  @ApiProperty() phoneVerified!: boolean;
  // Whether a password sign-in exists at all - a Google account has none until
  // it sets one. Never the hash itself; the profile page only needs to know
  // whether to offer "set a password" or "change password".
  @ApiProperty() hasPassword!: boolean;

  static fromRow(row: UserRow): UserResponse {
    return {
      id: row.id,
      name: row.name,
      email: row.email ?? undefined,
      phone: row.phone ?? undefined,
      via: row.via,
      isAdmin: row.isAdmin,
      emailVerified: row.emailVerified,
      phoneVerified: row.phoneVerified,
      hasPassword: !!row.passwordHash,
    };
  }
}
