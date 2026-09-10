import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsInt,
  IsUUID,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';

export class ExchangeItemDto {
  @ApiProperty({ description: 'Replacement product from the same shop' })
  @IsUUID()
  productId!: string;

  @ApiProperty({ description: 'How many of it', example: 1 })
  @IsInt()
  @Min(1)
  @Max(999)
  qty!: number;
}

/** What the buyer is getting instead. Nothing is charged for it. */
export class ExchangeOrderDto {
  @ApiProperty({ type: [ExchangeItemDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => ExchangeItemDto)
  items!: ExchangeItemDto[];
}
