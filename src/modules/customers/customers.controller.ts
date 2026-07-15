import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Public } from '../../common/decorators/public.decorator';
import { AdminJwtAuthGuard } from '../../common/guards/admin-jwt-auth.guard';
import { ShopScopeGuard } from '../../common/guards/shop-scope.guard';
import { CustomersService } from './customers.service';
import { CustomerQueryDto } from './dto/customer-query.dto';
import { MonthlyActivityQueryDto } from './dto/monthly-activity-query.dto';

@ApiTags('customers')
@Controller('shops/:shopId/customers')
@Public()
@UseGuards(AdminJwtAuthGuard, ShopScopeGuard)
@ApiBearerAuth()
export class CustomersController {
  constructor(private readonly customers: CustomersService) {}

  @Get()
  @ApiOperation({
    summary: 'Admin: paginated customer list (segment/q filters)',
  })
  list(@Param('shopId') shopId: string, @Query() query: CustomerQueryDto) {
    return this.customers.list(shopId, query);
  }

  @Get('analytics/monthly')
  @ApiOperation({
    summary: 'Admin: month-wise customer activity matrix (last N months)',
  })
  monthlyActivity(
    @Param('shopId') shopId: string,
    @Query() query: MonthlyActivityQueryDto,
  ) {
    return this.customers.monthlyActivity(shopId, query);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Admin: customer + order history' })
  getOne(@Param('shopId') shopId: string, @Param('id') id: string) {
    return this.customers.getWithHistory(shopId, id);
  }
}
