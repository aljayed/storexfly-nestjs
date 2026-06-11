import { ApiProperty } from '@nestjs/swagger';
import { IsEnum } from 'class-validator';
import { orderStatusEnum } from '../../../database/schema/enums';

type OrderStatus = (typeof orderStatusEnum.enumValues)[number];

export class UpdateOrderStatusDto {
  @ApiProperty({ enum: orderStatusEnum.enumValues })
  @IsEnum(orderStatusEnum.enumValues)
  status!: OrderStatus;
}
