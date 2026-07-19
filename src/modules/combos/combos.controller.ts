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
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Public } from '../../common/decorators/public.decorator';
import { AdminJwtAuthGuard } from '../../common/guards/admin-jwt-auth.guard';
import { RequirePerm } from '../../common/decorators/roles.decorator';
import { RolesGuard } from '../../common/guards/roles.guard';
import { ShopScopeGuard } from '../../common/guards/shop-scope.guard';
import { CombosService } from './combos.service';
import { CreateComboDto, UpdateComboDto } from './dto/create-combo.dto';

@ApiTags('combos')
@Controller()
export class CombosController {
  constructor(private readonly combos: CombosService) {}

  @Public()
  @UseGuards(AdminJwtAuthGuard, ShopScopeGuard, RolesGuard)
  @RequirePerm('combos.manage')
  @ApiBearerAuth()
  @Get('shops/:shopId/combos')
  @ApiOperation({ summary: 'Admin: list every combo offer of the shop' })
  list(@Param('shopId') shopId: string) {
    return this.combos.listForShop(shopId);
  }

  @Public()
  @UseGuards(AdminJwtAuthGuard, ShopScopeGuard, RolesGuard)
  @RequirePerm('combos.manage')
  @ApiBearerAuth()
  @Post('shops/:shopId/combos')
  @ApiOperation({ summary: 'Admin: create a combo offer' })
  create(@Param('shopId') shopId: string, @Body() dto: CreateComboDto) {
    return this.combos.create(shopId, dto);
  }

  @Public()
  @UseGuards(AdminJwtAuthGuard, ShopScopeGuard, RolesGuard)
  @RequirePerm('combos.manage')
  @ApiBearerAuth()
  @Patch('shops/:shopId/combos/:id')
  @ApiOperation({ summary: 'Admin: update a combo offer (price, members, …)' })
  update(
    @Param('shopId') shopId: string,
    @Param('id') id: string,
    @Body() dto: UpdateComboDto,
  ) {
    return this.combos.update(shopId, id, dto);
  }

  @Public()
  @UseGuards(AdminJwtAuthGuard, ShopScopeGuard, RolesGuard)
  @RequirePerm('combos.manage')
  @ApiBearerAuth()
  @Delete('shops/:shopId/combos/:id')
  @ApiOperation({ summary: 'Admin: delete a combo offer' })
  remove(@Param('shopId') shopId: string, @Param('id') id: string) {
    return this.combos.remove(shopId, id);
  }
}
