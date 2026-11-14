import { Module } from '@nestjs/common';
import { CurrencyController } from './currency.controller';
import { FxRatesService } from './fx-rates.service';

/**
 * Display currency for buyers: which currency a visitor reads prices in, and
 * the exchange rates to convert a shop's prices into it. Display only - no
 * order, charge or settlement ever uses these rates.
 */
@Module({
  controllers: [CurrencyController],
  providers: [FxRatesService],
})
export class CurrencyModule {}
