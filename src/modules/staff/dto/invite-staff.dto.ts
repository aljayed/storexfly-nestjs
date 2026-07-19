import { ApiProperty } from '@nestjs/swagger';
import { IsEmail, IsIn, MaxLength } from 'class-validator';
import {
  INVITABLE_ROLES,
  type InvitableRole,
} from '../../../common/auth/admin-permissions';

/** Send (or refresh) an email invitation to join the shop's admin console. */
export class InviteStaffDto {
  @ApiProperty({ example: 'rafi@example.com' })
  @IsEmail({}, { message: 'Enter a valid email address' })
  @MaxLength(320)
  email!: string;

  @ApiProperty({
    enum: INVITABLE_ROLES,
    description:
      "Access tier: 'manager' = full access, 'editor' = reports + add/edit/delete items, 'staff' = reports + add items only",
  })
  @IsIn(INVITABLE_ROLES as readonly string[], {
    message: 'Choose a valid access level',
  })
  role!: InvitableRole;
}

/** Change an existing team member's access tier. */
export class UpdateStaffRoleDto {
  @ApiProperty({ enum: INVITABLE_ROLES })
  @IsIn(INVITABLE_ROLES as readonly string[], {
    message: 'Choose a valid access level',
  })
  role!: InvitableRole;
}
