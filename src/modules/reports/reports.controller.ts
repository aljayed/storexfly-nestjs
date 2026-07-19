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

  @Get('reports/repeat-buyers')
  @ApiOperation({ summary: 'Admin: repeat-buyer report' })
  repeatBuyers(@Param('shopId') shopId: string) {
    return this.reports.repeatBuyers(shopId);
  }

  @Get('reports/export')
  @Header('Content-Type', 'text/csv')
  @ApiOperation({ summary: 'Admin: export orders as CSV' })
  async export(
    @Param('shopId') shopId: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<string> {
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="orders-${shopId}.csv"`,
    );
    return this.reports.exportOrdersCsv(shopId);
  }
}
