import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { Public } from '../../common/decorators/public.decorator';
import { RequirePerm } from '../../common/decorators/roles.decorator';
import { AdminJwtAuthGuard } from '../../common/guards/admin-jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { ShopScopeGuard } from '../../common/guards/shop-scope.guard';
import { ItemAiCardCopyDto, ItemAiTurnDto } from './dto/item-ai.dto';
import { ItemAiService } from './item-ai.service';

/**
 * "Add with AI" in the seller console. Same guards and permission as creating
 * a product by hand - this only drafts one, but a draft for a shop is still
 * that shop's business.
 */
@ApiTags('products')
@Controller()
export class ItemAiController {
  constructor(private readonly ai: ItemAiService) {}

  @Public()
  @UseGuards(AdminJwtAuthGuard, ShopScopeGuard, RolesGuard)
  @ApiBearerAuth()
  @RequirePerm('items.add')
  @Throttle({ default: { limit: 40, ttl: 60_000 } })
  @HttpCode(HttpStatus.OK)
  @Post('shops/:shopId/items/ai/turn')
  @ApiOperation({ summary: 'Admin: one turn of the add-with-AI chat' })
  turn(@Param('shopId') shopId: string, @Body() dto: ItemAiTurnDto) {
    return this.ai.turn(shopId, dto);
  }

  @Public()
  @UseGuards(AdminJwtAuthGuard, ShopScopeGuard, RolesGuard)
  @ApiBearerAuth()
  @RequirePerm('items.add')
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @HttpCode(HttpStatus.OK)
  @Post('shops/:shopId/items/ai/card-copy')
  @ApiOperation({ summary: 'Admin: words for a photo card template' })
  cardCopy(@Param('shopId') shopId: string, @Body() dto: ItemAiCardCopyDto) {
    return this.ai.cardCopy(shopId, dto);
  }
}
