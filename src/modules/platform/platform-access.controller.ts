import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { PlatformArea } from '../../common/decorators/platform-area.decorator';
import { Public } from '../../common/decorators/public.decorator';
import { PlatformJwtAuthGuard } from '../../common/guards/platform-jwt-auth.guard';
import type { PlatformPrincipal } from '../../common/types/principal';
import { PlatformAuditService } from '../platform-audit/platform-audit.service';
import {
  CreatePlatformRoleDto,
  CreatePlatformStaffDto,
  PlatformAuditQueryDto,
  UpdatePlatformRoleDto,
  UpdatePlatformStaffDto,
} from './dto/platform-access.dto';
import { PlatformAccessService } from './platform-access.service';

/** Team and access workspace: staff, roles and the audit log. */
@ApiTags('platform-admin')
@Public()
@UseGuards(PlatformJwtAuthGuard)
@PlatformArea('access')
@ApiBearerAuth()
@Controller('platform/access')
export class PlatformAccessController {
  constructor(
    private readonly access: PlatformAccessService,
    private readonly audit: PlatformAuditService,
  ) {}

  @Get('staff')
  @ApiOperation({ summary: 'Platform console: everyone on the team' })
  staff() {
    return this.access.staff();
  }

  @Post('staff')
  @ApiOperation({ summary: 'Add a staff member (returns a one-time password)' })
  createStaff(
    @CurrentUser() actor: PlatformPrincipal,
    @Body() dto: CreatePlatformStaffDto,
  ) {
    return this.access.createStaff(actor, dto);
  }

  @Patch('staff/:id')
  @ApiOperation({ summary: 'Rename, change role, suspend or restore' })
  updateStaff(
    @CurrentUser() actor: PlatformPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdatePlatformStaffDto,
  ) {
    return this.access.updateStaff(actor, id, dto);
  }

  @Post('staff/:id/reset-password')
  @ApiOperation({ summary: 'Issue a new one-time password' })
  resetPassword(
    @CurrentUser() actor: PlatformPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.access.resetPassword(actor, id);
  }

  @Post('staff/:id/reset-2fa')
  @ApiOperation({ summary: 'Make them set up their authenticator app again' })
  resetTwoFactor(
    @CurrentUser() actor: PlatformPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.access.resetTwoFactor(actor, id);
  }

  @Post('staff/:id/sign-out')
  @ApiOperation({ summary: 'End all their sessions now' })
  signOut(
    @CurrentUser() actor: PlatformPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.access.signOut(actor, id);
  }

  @Get('roles')
  @ApiOperation({ summary: 'Roles and what each can do' })
  roles() {
    return this.access.roles();
  }

  @Post('roles')
  @PlatformArea('access', 'approve')
  @ApiOperation({ summary: 'Create a role' })
  createRole(
    @CurrentUser() actor: PlatformPrincipal,
    @Body() dto: CreatePlatformRoleDto,
  ) {
    return this.access.createRole(actor, dto);
  }

  @Patch('roles/:key')
  @PlatformArea('access', 'approve')
  @ApiOperation({ summary: "Change a role's name or access" })
  updateRole(
    @CurrentUser() actor: PlatformPrincipal,
    @Param('key') key: string,
    @Body() dto: UpdatePlatformRoleDto,
  ) {
    return this.access.updateRole(actor, key, dto);
  }

  @Delete('roles/:key')
  @PlatformArea('access', 'approve')
  @ApiOperation({ summary: 'Delete an unused custom role' })
  deleteRole(@Param('key') key: string) {
    return this.access.deleteRole(key);
  }

  @Get('audit')
  @ApiOperation({ summary: 'The audit log, newest first' })
  auditLog(@Query() query: PlatformAuditQueryDto) {
    return this.audit.list(query);
  }
}
