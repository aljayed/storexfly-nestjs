import { Controller, Get, Header, Headers } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  BASE_DISPLAY_CURRENCY,
  DISPLAY_CURRENCIES,
  currencyForCountry,
  normalizeCountry,
} from '../../common/constants/display-currencies';
import { Public } from '../../common/decorators/public.decorator';
import { FxRatesService } from './fx-rates.service';

export interface CurrencyContextResponse {
  /** What `rates` are quoted against. */
  base: string;
  /** The visitor's country (ISO alpha-2), null when the edge could not say. */
  country: string | null;
  /** The currency to show this visitor unless they have chosen another. */
  currency: string;
  /** Units of each currency one `base` buys. Empty when no rates are usable -
   *  the storefront then shows each shop's own currency. */
  rates: Record<string, number>;
  /** When the rates were fetched; null with an empty `rates`. */
  asOf: string | null;
  /** Every currency the buyer may pick - empty when rates are unavailable. */
  currencies: readonly string[];
}

@ApiTags('currency')
@Controller('currency')
export class CurrencyController {
  constructor(private readonly fx: FxRatesService) {}

  /**
   * Where the visitor is and what a taka is worth there.
   *
   * The country comes from Cloudflare's `CF-IPCountry` header: the site is
   * already served through it, so the lookup costs nothing, calls no third
   * party and sends no visitor address anywhere new. The header is only a
   * display hint - a forged one changes the currency a person sees on their
   * own screen and nothing else, since every charge is made in the shop's
   * currency regardless.
   */
  @Public()
  @Get()
  // The answer depends on who is asking; no shared cache may keep it.
  @Header('Cache-Control', 'private, no-store')
  @ApiOperation({ summary: "Visitor's display currency and exchange rates" })
  context(
    @Headers('cf-ipcountry') cfCountry?: string,
  ): CurrencyContextResponse {
    const country = normalizeCountry(cfCountry);
    const snapshot = this.fx.current();
    if (!snapshot) {
      return {
        base: BASE_DISPLAY_CURRENCY,
        country,
        currency: BASE_DISPLAY_CURRENCY,
        rates: {},
        asOf: null,
        currencies: [],
      };
    }
    return {
      base: BASE_DISPLAY_CURRENCY,
      country,
      currency: currencyForCountry(country),
      rates: snapshot.rates,
      asOf: snapshot.fetchedAt.toISOString(),
      currencies: DISPLAY_CURRENCIES,
    };
  }
}
