import { CourierSettingsService } from './courier-settings.service';
import type { DrizzleDB } from '../../database/drizzle.types';

function harness(overrides: Record<string, unknown> = {}) {
  const row = {
    id: 'settings', courierRequired: false, carrybeeEnabled: true,
    carrybeeProduction: false, carrybeeClientId: 'client',
    carrybeeClientSecret: 'secret', carrybeeClientContext: 'context',
    carrybeeWebhookSecret: 'webhook-secret', ...overrides,
  };
  const update = jest.fn(() => ({
    set: (patch: object) => ({ where: () => ({ returning: async () => {
      Object.assign(row, patch);
      return [row];
    } }) }),
  }));
  const db = { query: { platformSettings: { findFirst: async () => row } }, update };
  return { service: new CourierSettingsService(db as unknown as DrizzleDB), row, update };
}

describe('CarryBee-only settings', () => {
  it('does not fall back to retired credentials when CarryBee is disabled', async () => {
    const { service } = harness({
      carrybeeEnabled: false,
      steadfastEnabled: true, steadfastApiKey: 'old-key', steadfastSecretKey: 'old-secret',
      pathaoEnabled: true, pathaoClientId: 'old-client', pathaoClientSecret: 'old-secret',
      pathaoUsername: 'old-user', pathaoPassword: 'old-password',
    });
    expect(await service.activeCourier()).toBeNull();
    await expect(service.setCourierRequired(true)).rejects.toThrow('Enable and configure CarryBee');
    const view = await service.view();
    expect(view).not.toHaveProperty('steadfast');
    expect(view).not.toHaveProperty('pathao');
    expect(JSON.stringify(view)).not.toContain('old-secret');
  });

  it('keeps existing parcels trackable when new bookings are disabled', async () => {
    const { service } = harness({ carrybeeEnabled: false });
    expect(await service.activeCourier()).toBeNull();
    expect(await service.carrybeeConfig()).toMatchObject({ clientId: 'client', sandbox: true });
  });

  it('treats whitespace-only stored credentials as incomplete', async () => {
    const { service } = harness({ carrybeeClientSecret: '   ' });
    expect(await service.activeCourier()).toBeNull();
    expect(await service.carrybeeConfig()).toBeNull();
  });

  it.each([{ enabled: false }, { clientId: '' }, { clientSecret: ' ' }, { clientContext: '' }])(
    'rejects disabling the required courier without changing stored credentials: %j',
    async (patch) => {
      const { service, row, update } = harness({ courierRequired: true });
      await expect(service.updateCarrybee(patch)).rejects.toThrow('Turn off the platform courier requirement');
      expect(update).not.toHaveBeenCalled();
      expect(row.carrybeeClientSecret).toBe('secret');
    },
  );

  it('preserves omitted secrets, masks them and refuses incomplete activation', async () => {
    const { service, row, update } = harness();
    const view = await service.updateCarrybee({ clientId: ' replacement ', production: true });
    expect(row).toMatchObject({ carrybeeClientId: 'replacement', carrybeeClientSecret: 'secret', carrybeeEnabled: true });
    expect(view.carrybee).toMatchObject({ hasSecret: true, production: true });
    expect(view.carrybee).not.toHaveProperty('clientSecret');
    update.mockClear();
    await expect(service.updateCarrybee({ enabled: true, clientContext: '' })).rejects.toThrow('before enabling');
    expect(update).not.toHaveBeenCalled();
  });
});
