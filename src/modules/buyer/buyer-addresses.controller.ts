import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { StorefrontSession } from '../../common/decorators/storefront-session.decorator';
import type { AccountPrincipal } from '../../common/types/principal';
import { BuyerAddressesService } from './buyer-addresses.service';
import { SaveBuyerAddressDto } from './dto/buyer-address.dto';

@StorefrontSession()
@ApiTags('buyer-addresses')
@ApiBearerAuth()
@Controller('buyer/addresses')
export class BuyerAddressesController {
  constructor(private readonly addresses: BuyerAddressesService) {}

  @Get()
  list(@CurrentUser() user: AccountPrincipal) {
    return this.addresses.list(user.id);
  }

  @Post()
  add(@CurrentUser() user: AccountPrincipal, @Body() dto: SaveBuyerAddressDto) {
    return this.addresses.save(user.id, dto);
  }

  @Patch(':id')
  update(
    @CurrentUser() user: AccountPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SaveBuyerAddressDto,
  ) {
    return this.addresses.save(user.id, dto, id);
  }

  @Patch(':id/default')
  setDefault(
    @CurrentUser() user: AccountPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.addresses.setDefault(user.id, id);
  }

  @Delete(':id')
  remove(
    @CurrentUser() user: AccountPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.addresses.remove(user.id, id);
  }
}
