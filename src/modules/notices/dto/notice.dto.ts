import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
} from 'class-validator';
import type { NoticeTone } from '../../../database/schema';

const TONES: NoticeTone[] = ['info', 'success', 'warning', 'danger'];

/** One announcement as either console sees it. */
export class NoticeResponse {
  @ApiProperty() id!: string;
  @ApiPropertyOptional({
    description: 'Target shop; absent = broadcast to every shop',
  })
  shopId?: string;
  @ApiPropertyOptional({ description: 'Target shop name (platform list only)' })
  shopName?: string;
  @ApiProperty() message!: string;
  @ApiProperty({ enum: TONES }) tone!: NoticeTone;
  @ApiProperty() active!: boolean;
  @ApiProperty() createdAt!: string;
}

export class NoticeListResponse {
  @ApiProperty({ type: [NoticeResponse] }) data!: NoticeResponse[];
}

export class CreateNoticeDto {
  @ApiProperty({ maxLength: 300 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(300)
  message!: string;

  @ApiPropertyOptional({ enum: TONES, default: 'info' })
  @IsOptional()
  @IsIn(TONES)
  tone?: NoticeTone;

  @ApiPropertyOptional({ description: 'Omit to broadcast to every shop' })
  @IsOptional()
  @IsUUID()
  shopId?: string;
}

export class UpdateNoticeDto {
  @ApiPropertyOptional({ maxLength: 300 })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(300)
  message?: string;

  @ApiPropertyOptional({ enum: TONES })
  @IsOptional()
  @IsIn(TONES)
  tone?: NoticeTone;

  @ApiPropertyOptional({ description: 'Hide/show the banner everywhere' })
  @IsOptional()
  @IsBoolean()
  active?: boolean;
}
