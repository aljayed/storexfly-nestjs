import {
  Controller,
  Get,
  Header,
  Param,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { Public } from '../../common/decorators/public.decorator';
import { RequirePerm } from '../../common/decorators/roles.decorator';
import { RolesGuard } from '../../common/guards/roles.guard';
import { AdminJwtAuthGuard } from '../../common/guards/admin-jwt-auth.guard';
import { ShopScopeGuard } from '../../common/guards/shop-scope.guard';
import { DashboardQuery } from './dto/dashboard-query.dto';
import { ReportsService } from './reports.service';

@ApiTags('reports')
@Controller('shops/:shopId')
@Public()
@UseGuards(AdminJwtAuthGuard, ShopScopeGuard, RolesGuard)
@RequirePerm('reports.view')
@ApiBearerAuth()
export class ReportsController {
  constructor(private readonly reports: ReportsService) {}

  @Get('dashboard')
  @ApiOperation({
    summary: 'Admin: dashboard KPIs + revenue series (optional ?from=&to=)',
  })
  dashboard(@Param('shopId') shopId: string, @Query() query: DashboardQuery) {
    return this.reports.dashboard(shopId, query.from, query.to);
  }

  @Get('reports/insights')
  @ApiOperation({
    summary:
      'Admin: full insights report for a window - sales, fulfilment, payments, channels, discounts, areas, products',
  })
  insights(@Param('shopId') shopId: string, @Query() query: DashboardQuery) {
    return this.reports.insights(shopId, query.from, query.to);
  }

  @Get('reports/export')
  @Header('Content-Type', 'text/csv; charset=utf-8')
  @ApiOperation({
    summary: 'Admin: export orders as CSV (optional ?from=&to= scopes it)',
  })
  async export(
    @Param('shopId') shopId: string,
    @Query() query: DashboardQuery,
    @Res({ passthrough: true }) res: Response,
  ): Promise<string> {
    const suffix = query.from ? `-${query.from.slice(0, 10)}` : '';
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="orders${suffix}.csv"`,
    );
    return this.reports.exportOrdersCsv(shopId, query.from, query.to);
  }
}
