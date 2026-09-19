import { BadRequestException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { CarrybeeService } from '../gateways/carrybee.service';
import { CourierSettingsService } from '../gateways/courier-settings.service';
import type { DeliverySettingsDto } from './dto/delivery-settings.dto';

@Injectable()
export class ShopDeliveryService {
  constructor(private readonly settings: CourierSettingsService, private readonly carrybee: CarrybeeService) {}

  async options() {
    const active = await this.settings.activeCourier();
    return { carrybeeAvailable: active?.provider === 'carrybee' };
  }

  private async config() {
    const active = await this.settings.activeCourier();
    if (active?.provider !== 'carrybee') throw new ServiceUnavailableException('Hoomri delivery via CarryBee is currently unavailable. Please try again later or choose manual delivery.');
    return active.config;
  }

  async cities() { return { places: await this.carrybee.cities(await this.config()) }; }
  async zones(cityId: number) { return { places: await this.carrybee.zones(await this.config(), cityId) }; }
  async areas(cityId: number, zoneId: number) { return { places: await this.carrybee.areas(await this.config(), cityId, zoneId) }; }

  async validate(input: DeliverySettingsDto): Promise<void> {
    if (!input.deliveryMode) return; // Legacy shops keep their existing policy.
    if (!input.pickupDistrict?.trim() || !input.pickupContactName?.trim() ||
        !/^(?:\+?88)?01[3-9]\d{8}$/.test(input.pickupPhone?.trim() ?? '') ||
        (input.pickupAddress?.trim().length ?? 0) < 10) {
      throw new BadRequestException('Add a city / district, pickup contact, valid Bangladesh mobile number and a complete pickup address (at least 10 characters).');
    }
    if (input.deliveryMode !== 'carrybee') return;
    if (!input.pickupCityId || !input.pickupZoneId || !input.pickupAreaId) {
      throw new BadRequestException('Select the CarryBee pickup city, zone and area.');
    }
    // CarryBee truncates pickup addresses at 100 chars; never silently lose a house number.
    if (input.pickupAddress!.length > 100) throw new BadRequestException('Keep the CarryBee pickup address within 100 characters.');
    const config = await this.config();
    const [cities, zones, areas] = await Promise.all([
      this.carrybee.cities(config), this.carrybee.zones(config, input.pickupCityId),
      this.carrybee.areas(config, input.pickupCityId, input.pickupZoneId),
    ]);
    if (!cities.some(p => p.id === input.pickupCityId) || !zones.some(p => p.id === input.pickupZoneId) || !areas.some(p => p.id === input.pickupAreaId)) {
      throw new BadRequestException('The pickup location is not in CarryBee’s current coverage. Select the city, zone and area again.');
    }
  }
}
