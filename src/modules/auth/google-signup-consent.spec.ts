import { BadRequestException, ConflictException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import type { ConfigService } from '@nestjs/config';
import type { Profile } from 'passport-google-oauth20';
import type { UserRow } from '../../database/schema';
import type { UsersService } from '../users/users.service';
import { AuthService } from './auth.service';
import { CompleteGoogleSignupDto } from './dto/complete-google-signup.dto';
import { GoogleStrategy } from './strategies/google.strategy';
import { TokenService } from './token.service';

/*
 * Nobody gets an account from Google without agreeing to the policies first.
 * Someone new comes back from Google with a short-lived ticket instead of an
 * account; the storefront asks them, and only "Agree & continue" trades the
 * ticket in. Cancelling sends nothing, so nothing is made. The ticket creates
 * and never signs in, so it cannot be replayed as a login.
 */

const config = {
  getOrThrow: (key: string) =>
    ({
      'jwt.secret': 'test-session-secret',
      'jwt.expiresIn': '1h',
      'google.callbackUrl': 'http://localhost/api/auth/google/callback',
    })[key],
  get: () => undefined,
} as unknown as ConfigService;

const jwt = new JwtService();
const tokens = new TokenService(jwt, config);

const profile = { googleId: 'g-1', email: 'new@example.com', name: 'Nusrat' };
const created = {
  id: 'u1',
  publicId: 'p1',
  name: 'Nusrat',
  email: 'new@example.com',
  googleId: 'g-1',
  via: 'google',
  isAdmin: false,
  emailVerified: true,
  phoneVerified: false,
  passwordHash: null,
} as unknown as UserRow;

function usersWith(existing: UserRow | null) {
  const upsert = jest.fn().mockResolvedValue(created);
  const users = {
    findGoogleAccount: jest.fn().mockResolvedValue(existing),
    upsertGoogleUser: upsert,
  } as unknown as UsersService;
  return { users, upsert };
}

function authWith(users: UsersService) {
  const sessionScope = { resolve: () => Promise.resolve('account') };
  return new AuthService(
    users,
    tokens,
    {} as never,
    {} as never,
    {} as never,
    sessionScope as never,
  );
}

const googleProfile = {
  id: 'g-1',
  displayName: 'Nusrat',
  emails: [{ value: 'new@example.com' }],
} as unknown as Profile;

describe('Google sign-in for someone new', () => {
  it('creates nothing, and hands back a pending sign-up', async () => {
    const { users, upsert } = usersWith(null);
    const strategy = new GoogleStrategy(config, users);
    const done = jest.fn();
    await strategy.validate('', '', googleProfile, done);
    expect(upsert).not.toHaveBeenCalled();
    expect(done).toHaveBeenCalledWith(null, { googleSignup: profile });
  });

  it('signs an existing account in exactly as before', async () => {
    const { users, upsert } = usersWith(created);
    const strategy = new GoogleStrategy(config, users);
    const done = jest.fn();
    await strategy.validate('', '', googleProfile, done);
    expect(upsert).toHaveBeenCalledWith(profile);
    expect(done).toHaveBeenCalledWith(null, created);
  });
});

describe('the sign-up ticket', () => {
  it('is not a session: the session key cannot read it', async () => {
    const ticket = await authWith(usersWith(null).users).startGoogleSignup(
      profile,
    );
    await expect(
      jwt.verifyAsync(ticket, { secret: 'test-session-secret' }),
    ).rejects.toThrow();
  });

  it('creates the account and signs it in once agreed', async () => {
    const { users, upsert } = usersWith(null);
    const auth = authWith(users);
    const result = await auth.completeGoogleSignup(
      await auth.startGoogleSignup(profile),
    );
    expect(upsert).toHaveBeenCalledWith(profile);
    expect(result.user.email).toBe('new@example.com');
    const session = await jwt.verifyAsync<{ typ: string; sub: string }>(
      result.token,
      { secret: 'test-session-secret' },
    );
    expect(session).toMatchObject({ typ: 'seller', sub: 'u1' });
  });

  it('never signs into an account that already exists - no replay', async () => {
    const ticket = await authWith(usersWith(null).users).startGoogleSignup(
      profile,
    );
    const { users, upsert } = usersWith(created);
    await expect(
      authWith(users).completeGoogleSignup(ticket),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(upsert).not.toHaveBeenCalled();
  });

  it('refuses a ticket that was not issued here', async () => {
    const forged = await jwt.signAsync(
      { gid: 'g-1', email: 'new@example.com', name: 'x', typ: 'google-signup' },
      { secret: 'test-session-secret' },
    );
    const { users, upsert } = usersWith(null);
    await expect(
      authWith(users).completeGoogleSignup(forged),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(upsert).not.toHaveBeenCalled();
  });
});

describe('POST /auth/google/complete body', () => {
  const errorsFor = (body: object) =>
    validate(plainToInstance(CompleteGoogleSignupDto, body));

  it('needs the agreement itself, not just the ticket', async () => {
    expect(await errorsFor({ ticket: 't' })).not.toHaveLength(0);
    expect(await errorsFor({ ticket: 't', agreed: false })).not.toHaveLength(0);
    expect(await errorsFor({ ticket: 't', agreed: 'true' })).not.toHaveLength(
      0,
    );
    expect(await errorsFor({ ticket: 't', agreed: true })).toHaveLength(0);
  });
});
