import {
  hasGrant,
  OWNER_GRANTS,
  PLATFORM_WORKSPACES,
  sanitizeGrants,
} from './platform-access';

describe('platform access levels', () => {
  it('ranks view < act < approve', () => {
    const grants = { finance: 'act' as const };
    expect(hasGrant(grants, 'finance', 'view')).toBe(true);
    expect(hasGrant(grants, 'finance', 'act')).toBe(true);
    expect(hasGrant(grants, 'finance', 'approve')).toBe(false);
  });

  it('treats a missing workspace as no access', () => {
    expect(hasGrant({ support: 'approve' }, 'finance', 'view')).toBe(false);
  });

  it('gives the owner approve everywhere', () => {
    for (const w of PLATFORM_WORKSPACES) {
      expect(hasGrant(OWNER_GRANTS, w, 'approve')).toBe(true);
    }
  });

  it('drops unknown workspaces and levels from role edits', () => {
    expect(
      sanitizeGrants({
        support: 'act',
        finance: 'superuser',
        bogus: 'approve',
        __proto__: { access: 'approve' },
      }),
    ).toEqual({ support: 'act' });
    expect(sanitizeGrants(null)).toEqual({});
    expect(sanitizeGrants('approve')).toEqual({});
  });
});
