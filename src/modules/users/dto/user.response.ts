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

  static fromRow(row: UserRow): UserResponse {
    return {
      id: row.id,
      name: row.name,
      email: row.email ?? undefined,
      phone: row.phone ?? undefined,
      via: row.via,
      isAdmin: row.isAdmin,
    };
  }
}
