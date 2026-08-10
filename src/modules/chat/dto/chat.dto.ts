import { Type } from 'class-transformer';
import {
  ArrayNotEmpty,
  IsArray,
  IsIn,
  IsInt,
  IsNotEmpty,
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

export class SendMessageDto {
  @IsIn(['text', 'product', 'order', 'image', 'file'])
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
