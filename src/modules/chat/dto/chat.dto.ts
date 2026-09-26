import { Type } from 'class-transformer';
import {
  ArrayNotEmpty,
  IsArray,
  IsIn,
  IsInt,
  IsLatitude,
  IsLongitude,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import type { ChatMessageType, ChatOriginType } from '../../../database/schema';

/** Inline attachment payload - data URL, same approach as product images. */
export class ChatAttachmentDto {
  @IsIn(['image', 'file'])
  kind!: 'image' | 'file';

  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  fileName!: string;

  @IsString()
  @MaxLength(127)
  mimeType!: string;

  @IsInt()
  @Min(1)
  sizeBytes!: number;

  // ~8 MB of base64 keeps the request comfortably under the 15 MB JSON cap.
  @IsString()
  @MaxLength(11_000_000)
  dataUrl!: string;
}

/** One position fix from the sender's device. */
export class ChatLocationFixDto {
  // IsLatitude alone also passes numeric strings; the card stores numbers.
  @IsNumber()
  @IsLatitude()
  lat!: number;

  @IsNumber()
  @IsLongitude()
  lng!: number;

  /** Metres, as the device reported it. Anything past 100 km is noise. */
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(100_000)
  accuracy?: number;
}

/** Durations a live share can run for, in minutes (as WhatsApp offers). */
export const LIVE_LOCATION_MINUTES = [15, 60, 480] as const;

export class ChatLocationDto extends ChatLocationFixDto {
  /** Absent = a one-off pin; otherwise how long the live share runs. */
  @IsOptional()
  @IsIn(LIVE_LOCATION_MINUTES)
  liveMinutes?: (typeof LIVE_LOCATION_MINUTES)[number];
}

export class SendMessageDto {
  @IsIn(['text', 'product', 'order', 'image', 'file', 'location'])
  type!: Exclude<ChatMessageType, 'system'>;

  @IsOptional()
  @IsString()
  @MaxLength(4000)
  text?: string;

  /** For type 'product' - the server builds the snapshot. */
  @IsOptional()
  @IsUUID()
  productId?: string;

  /** For type 'order' - the server builds the snapshot. */
  @IsOptional()
  @IsUUID()
  orderId?: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => ChatAttachmentDto)
  attachment?: ChatAttachmentDto;

  /** For type 'location'. */
  @IsOptional()
  @ValidateNested()
  @Type(() => ChatLocationDto)
  location?: ChatLocationDto;

  /** Client-generated id echoed back for optimistic-UI reconciliation. */
  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  clientRef!: string;
}

export class ConversationOriginDto {
  @IsIn(['product', 'order'])
  type!: ChatOriginType;

  @IsUUID()
  refId!: string;
}

export class StartConversationDto {
  @IsUUID()
  shopId!: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => ConversationOriginDto)
  origin?: ConversationOriginDto;

  /** Optional first message, e.g. the auto-attached product card. */
  @IsOptional()
  @ValidateNested()
  @Type(() => SendMessageDto)
  initialMessage?: SendMessageDto;
}

export class MarkReadDto {
  /** All counterpart messages up to and including this one become read. */
  @IsUUID()
  upToMessageId!: string;
}

export class ListConversationsQuery {
  @IsOptional()
  @IsIn(['all', 'unread'])
  filter?: 'all' | 'unread';

  @IsOptional()
  @IsString()
  @MaxLength(160)
  q?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  cursor?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}

export class ListMessagesQuery {
  /** Paginate backwards from this message id. */
  @IsOptional()
  @IsUUID()
  cursor?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}

export class QuickReplyDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  text!: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  sortOrder?: number;
}

/** Every visible quick reply id, in the seller's desired display order. */
export class ReorderQuickRepliesDto {
  @IsArray()
  @ArrayNotEmpty()
  @IsUUID(undefined, { each: true })
  ids!: string[];
}

/** POST /chat/conversations/with - open a thread with a published handle. */
export class StartWithHandleDto {
  @IsString()
  @MaxLength(40)
  handle!: string;
}
