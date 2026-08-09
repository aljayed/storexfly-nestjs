import * as bcrypt from 'bcryptjs';
import type { UserRow } from '../../database/schema';
import { AuthService } from './auth.service';
import { UsersService } from '../users/users.service';

/**
 * The two sign-in doors must both stay open, whichever order they are opened
 * in: setting a password never detaches Google, and signing in with Google
 * never clears a password. Nothing in the product should ever leave an account
 * with only the door it did not choose.
 */

const googleOnly = {
  id: 'u1',
  name: 'Owner',
  email: 'owner@example.com',
  googleId: 'g-123',
  passwordHash: null,
  via: 'google',
  emailVerified: true,
  phoneVerified: false,
  isAdmin: false,
} as unknown as UserRow;

const passwordOnly = {
  ...googleOnly,
  id: 'u2',
  email: 'seller@example.com',
  googleId: null,
  passwordHash: bcrypt.hashSync('original-pw', 4),
  via: 'email',
} as unknown as UserRow;

/** AuthService.setPassword only reads the user and writes one hash back. */
function authServiceFor(row: UserRow) {
  const writes: { id: string; passwordHash: string }[] = [];
  const users = {
    findById: () => Promise.resolve(row),
    updatePassword: (id: string, passwordHash: string) => {
      writes.push({ id, passwordHash });
      return Promise.resolve();
    },
  } as unknown as UsersService;
  const service = new AuthService(
    users,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  );
  return { service, writes };
}

/** UsersService.upsertGoogleUser against a single stored row. */
function usersServiceFor(row: UserRow) {
  let patch: Partial<UserRow> | undefined;
  // upsertGoogleUser looks the account up twice: by google id (a miss - this
  // google account is new to us), then by email (a hit - the same person
  // already registered with a password). Distinguished by call order rather
  // than by parsing the drizzle expression.
  let lookups = 0;
  const db = {
    query: {
      users: {
        findFirst: () => Promise.resolve(lookups++ === 0 ? undefined : row),
      },
    },
    update: () => ({
      set: (value: Partial<UserRow>) => ({
        where: () => ({
          returning: () => {
            patch = value;
            return Promise.resolve([{ ...row, ...value }]);
          },
        }),
      }),
    }),
  };
  return { users: new UsersService(db as never), patch: () => patch };
}

describe('password and Google sign-in coexist', () => {
  it('keeps the Google link when a password is set', async () => {
    const { service, writes } = authServiceFor(googleOnly);

    const result = await service.setPassword('u1', { password: 'new-pw-123' });

    expect(writes).toHaveLength(1);
    expect(result.hasPassword).toBe(true);
    // Only the hash is written - googleId is never part of the patch, so the
    // account can still come back through Google.
    expect(Object.keys(writes[0])).toEqual(['id', 'passwordHash']);
    expect(await bcrypt.compare('new-pw-123', writes[0].passwordHash)).toBe(
      true,
    );
  });

  it('refuses to replace an existing password without the current one', async () => {
    const { service, writes } = authServiceFor(passwordOnly);

    await expect(
      service.setPassword('u2', { password: 'attacker-pw' }),
    ).rejects.toMatchObject({ status: 401 });
    await expect(
      service.setPassword('u2', {
        password: 'attacker-pw',
        currentPassword: 'wrong',
      }),
    ).rejects.toMatchObject({ status: 401 });
    expect(writes).toHaveLength(0);

    await service.setPassword('u2', {
      password: 'chosen-pw',
      currentPassword: 'original-pw',
    });
    expect(writes).toHaveLength(1);
  });

  it('keeps the password when Google is linked to an email account', async () => {
    const { users, patch } = usersServiceFor(passwordOnly);

    const linked = await users.upsertGoogleUser({
      googleId: 'g-999',
      email: 'seller@example.com',
      name: 'Seller',
    });

    // The link writes the google id and nothing that could unset the password.
    expect(patch()).toEqual({
      googleId: 'g-999',
      via: 'google',
      emailVerified: true,
    });
    expect(linked.passwordHash).toBe(passwordOnly.passwordHash);
  });
});
