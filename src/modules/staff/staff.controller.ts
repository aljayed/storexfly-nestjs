import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Public } from '../../common/decorators/public.decorator';
import { RequirePerm } from '../../common/decorators/roles.decorator';
import { AdminJwtAuthGuard } from '../../common/guards/admin-jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { ShopScopeGuard } from '../../common/guards/shop-scope.guard';
import type { AdminPrincipal } from '../../common/types/principal';
import { AcceptInviteDto } from './dto/accept-invite.dto';
import { InviteStaffDto, UpdateStaffRoleDto } from './dto/invite-staff.dto';
import { StaffService } from './staff.service';

@ApiTags('staff')
@Controller()
export class StaffController {
  constructor(private readonly staff: StaffService) {}

  // ── Team management (admin console, full access only) ────────
  @Public()
  @UseGuards(AdminJwtAuthGuard, ShopScopeGuard, RolesGuard)
  @RequirePerm('team.manage')
  @ApiBearerAuth()
  @Get('shops/:shopId/staff')
  @ApiOperation({ summary: 'Admin: team roster + pending invites' })
  list(@Param('shopId') shopId: string) {
    return this.staff.list(shopId);
  }

  @Public()
  @UseGuards(AdminJwtAuthGuard, ShopScopeGuard, RolesGuard)
  @RequirePerm('team.manage')
  @ApiBearerAuth()
  @Post('shops/:shopId/staff/invites')
  @ApiOperation({ summary: 'Admin: invite a member by email (24h link)' })
  invite(
    @Param('shopId') shopId: string,
    @CurrentUser() admin: AdminPrincipal,
    @Body() dto: InviteStaffDto,
  ) {
    return this.staff.invite(shopId, admin, dto.email, dto.role);
  }

  @Public()
  @UseGuards(AdminJwtAuthGuard, ShopScopeGuard, RolesGuard)
  @RequirePerm('team.manage')
  @ApiBearerAuth()
  @Post('shops/:shopId/staff/invites/:inviteId/resend')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Admin: re-send an invite with a fresh 24h link' })
  resend(
    @Param('shopId') shopId: string,
    @Param('inviteId') inviteId: string,
    @CurrentUser() admin: AdminPrincipal,
  ) {
    return this.staff.resend(shopId, admin, inviteId);
  }

  @Public()
  @UseGuards(AdminJwtAuthGuard, ShopScopeGuard, RolesGuard)
  @RequirePerm('team.manage')
  @ApiBearerAuth()
  @Delete('shops/:shopId/staff/invites/:inviteId')
  @ApiOperation({ summary: 'Admin: revoke a pending invite' })
  revoke(@Param('shopId') shopId: string, @Param('inviteId') inviteId: string) {
    return this.staff.revoke(shopId, inviteId);
  }

  @Public()
  @UseGuards(AdminJwtAuthGuard, ShopScopeGuard, RolesGuard)
  @RequirePerm('team.manage')
  @ApiBearerAuth()
  @Patch('shops/:shopId/staff/:memberId')
  @ApiOperation({ summary: "Admin: change a member's access level" })
  updateRole(
    @Param('shopId') shopId: string,
    @Param('memberId') memberId: string,
    @CurrentUser() admin: AdminPrincipal,
    @Body() dto: UpdateStaffRoleDto,
  ) {
    return this.staff.updateRole(shopId, admin, memberId, dto.role);
  }

  @Public()
  @UseGuards(AdminJwtAuthGuard, ShopScopeGuard, RolesGuard)
  @RequirePerm('team.manage')
  @ApiBearerAuth()
  @Delete('shops/:shopId/staff/:memberId')
  @ApiOperation({ summary: 'Admin: remove a member from the team' })
  remove(
    @Param('shopId') shopId: string,
    @Param('memberId') memberId: string,
    @CurrentUser() admin: AdminPrincipal,
  ) {
    return this.staff.removeMember(shopId, admin, memberId);
  }

  // ── Invite redemption (public — the invitee has no session yet) ──
  @Public()
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Get('staff/invites/:token')
  @ApiOperation({ summary: 'Invite preview (shop, email, access level)' })
  preview(@Param('token') token: string) {
    return this.staff.preview(token);
  }

  @Public()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('staff/invites/:token/accept')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Accept an invite → console account + admin JWT' })
  accept(@Param('token') token: string, @Body() dto: AcceptInviteDto) {
    return this.staff.accept(token, dto.name, dto.password);
  }
}
