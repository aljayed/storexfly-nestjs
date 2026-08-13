import { RISK_WINDOW_HOURS } from '../risk/risk.service';
import { repeatItemWindowStart } from './orders.service';

/**
 * "Already ordered this" and the sign-in / phone gates must expire together.
 * Two windows that look the same but lapse at different moments is the kind of
 * difference nobody notices until a buyer is asked to prove themselves for an
 * order the duplicate rule has already stopped caring about.
 */
describe('repeatItemWindowStart', () => {
  const HOUR_MS = 60 * 60 * 1000;
  const now = Date.parse('2026-08-13T14:30:00Z');

  it('looks back exactly the risk window', () => {
    expect(now - repeatItemWindowStart(now).getTime()).toBe(
      RISK_WINDOW_HOURS * HOUR_MS,
    );
  });

  it('is twelve hours', () => {
    expect(RISK_WINDOW_HOURS).toBe(12);
  });

  // The boundary decides whether an order placed exactly at the edge counts.
  // `gte` includes it, so the edge must sit inside the window, not before it.
  it('puts an order from just inside the window on or after the boundary', () => {
    const justInside = new Date(now - (RISK_WINDOW_HOURS * HOUR_MS - 1000));
    expect(justInside.getTime()).toBeGreaterThanOrEqual(
      repeatItemWindowStart(now).getTime(),
    );
  });

  it('puts an order from just outside the window before the boundary', () => {
    const justOutside = new Date(now - (RISK_WINDOW_HOURS * HOUR_MS + 1000));
    expect(justOutside.getTime()).toBeLessThan(
      repeatItemWindowStart(now).getTime(),
    );
  });

  it('rolls forward with the clock rather than sitting on a calendar edge', () => {
    const later = repeatItemWindowStart(now + 3 * HOUR_MS);
    expect(later.getTime() - repeatItemWindowStart(now).getTime()).toBe(
      3 * HOUR_MS,
    );
  });
});
