import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiProperty,
  ApiPropertyOptional,
  ApiTags,
} from '@nestjs/swagger';
import {
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';
import { Throttle } from '@nestjs/throttler';
import { Public } from '../../common/decorators/public.decorator';
import { PlatformJwtAuthGuard } from '../../common/guards/platform-jwt-auth.guard';
import { MailAccountsService } from '../mail/mail-accounts.service';

export class CreateMailAccountDto {
  @ApiProperty({
    example: 'ops',
    description: "The part before the @ - the domain is the platform's own",
  })
  @IsString()
  @Matches(/^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/i, {
    message:
      'Use letters, numbers, dots, dashes and underscores - starting and ending with a letter or number.',
  })
  localPart!: string;

  @ApiPropertyOptional({
    description: 'Leave empty to have a strong one generated',
    minLength: 12,
  })
  @IsOptional()
  @IsString()
  @MinLength(12)
  @MaxLength(200)
  password?: string;

  @ApiPropertyOptional({ example: 'Rakib - operations' })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  label?: string;
}

export class ResetMailPasswordDto {
  @ApiPropertyOptional({
    description: 'Leave empty to have a strong one generated',
    minLength: 12,
  })
  @IsOptional()
  @IsString()
  @MinLength(12)
  @MaxLength(200)
  password?: string;
}

export class SetMailLabelDto {
  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  label?: string;
}

/**
 * Operator console: the staff mailboxes on the platform's own mail domain.
 *
 * Creating one writes straight into the mailserver's account file, so these
 * routes are behind the platform-admin guard and nothing else. Passwords come
 * back exactly once, in the response that set them - they are hashed into the
 * mailserver and never stored here, so there is no second chance to read one.
 *
 * Deletion is refused for locked mailboxes: everything that predates this
 * console, plus anything added over SSH, plus the address the platform sends
 * its own mail from.
 */
@ApiTags('platform-admin')
@Public()
@UseGuards(PlatformJwtAuthGuard)
@ApiBearerAuth()
@Controller('platform/mail')
export class PlatformMailController {
  constructor(private readonly accounts: MailAccountsService) {}

  @Get()
  @ApiOperation({
    summary: 'Platform: staff mailboxes, and whether management is available',
  })
  async list() {
    const configured = await this.accounts.isConfigured();
    return {
      configured,
      accounts: configured ? await this.accounts.list() : [],
    };
  }

  // Creating a mailbox is cheap for us and expensive to undo, and each one is
  // a new way into the mail domain - so it is rate limited well below the
  // console's usual allowance.
  @Post()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOperation({
    summary: 'Platform: create a staff mailbox (password returned once)',
  })
  create(@Body() dto: CreateMailAccountDto) {
    return this.accounts.create(dto);
  }

  @Post(':address/password')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOperation({
    summary: 'Platform: set a new password (returned once)',
  })
  resetPassword(
    @Param('address') address: string,
    @Body() dto: ResetMailPasswordDto,
  ) {
    return this.accounts.resetPassword(address, dto.password);
  }

  @Patch(':address')
  @ApiOperation({ summary: "Platform: rename the console's label for a box" })
  async setLabel(
    @Param('address') address: string,
    @Body() dto: SetMailLabelDto,
  ) {
    await this.accounts.setLabel(address, dto.label ?? null);
    return { address: address.toLowerCase() };
  }

  @Delete(':address')
  @ApiOperation({
    summary: 'Platform: delete a staff mailbox (refused when locked)',
  })
  remove(@Param('address') address: string) {
    return this.accounts.remove(address);
  }
}
