import { describe, expect, test } from 'vitest';

import {
  createExpiredTurnCredentials,
  productionSmokeAccounts,
  smokeAuthenticationRequests,
  smokeP2pMediaPlan,
} from '../../deploy/scripts/smoke.mjs';
import { P2P_MEDIA_PLAN } from '../../packages/protocol/src/room.ts';

const productionEnvironment = Object.freeze({
  DEPLOY_SMOKE_EMAILS:
    ' Smoke-One@Example.Test,smoke-two@example.test,smoke-three@example.test ',
  DEPLOY_SMOKE_PASSWORD: 'correct-horse-battery-staple',
  EMAIL_DOMAIN_ALLOWLIST: 'example.test',
  EMAIL_VERIFICATION_REQUIRED: 'true',
});

describe('production smoke account policy', () => {
  test('uses the current three-transceiver media plan', () => {
    expect(smokeP2pMediaPlan).toBe(P2P_MEDIA_PLAN);
  });

  test('uses exactly three existing allowlisted accounts without registering users', () => {
    expect(productionSmokeAccounts(productionEnvironment)).toEqual([
      {
        email: 'smoke-one@example.test',
        password: 'correct-horse-battery-staple',
      },
      {
        email: 'smoke-two@example.test',
        password: 'correct-horse-battery-staple',
      },
      {
        email: 'smoke-three@example.test',
        password: 'correct-horse-battery-staple',
      },
    ]);

    const requests = smokeAuthenticationRequests(productionEnvironment);
    expect(requests).toHaveLength(3);
    expect(requests.every(({ path }) => path === '/v1/auth/login')).toBe(true);
    expect(requests.every(({ expectedStatus }) => expectedStatus === 200)).toBe(
      true,
    );
    expect(requests.some(({ path }) => path === '/v1/auth/register')).toBe(
      false,
    );
  });

  test.each([
    [
      'missing accounts',
      { DEPLOY_SMOKE_EMAILS: '' },
      /exactly three unique accounts/i,
    ],
    [
      'duplicate accounts',
      {
        DEPLOY_SMOKE_EMAILS:
          'same@example.test,same@example.test,third@example.test',
      },
      /exactly three unique accounts/i,
    ],
    [
      'reserved invalid domain',
      {
        DEPLOY_SMOKE_EMAILS:
          'one@example.invalid,two@example.invalid,three@example.invalid',
      },
      /invalid account/i,
    ],
    [
      'account outside the application allowlist',
      {
        DEPLOY_SMOKE_EMAILS:
          'one@other.test,two@example.test,three@example.test',
      },
      /outside EMAIL_DOMAIN_ALLOWLIST/i,
    ],
    [
      'short password',
      { DEPLOY_SMOKE_PASSWORD: 'too-short' },
      /10 to 128 characters/i,
    ],
  ])('fails closed for %s', (_label, override, expected) => {
    expect(() =>
      productionSmokeAccounts({
        ...productionEnvironment,
        ...override,
      }),
    ).toThrow(expected);
  });

  test('keeps registration restricted to the isolated integration plan', () => {
    const requests = smokeAuthenticationRequests({}, true);
    expect(requests).toHaveLength(3);
    expect(requests.every(({ path }) => path === '/v1/auth/register')).toBe(
      true,
    );
    expect(requests.every(({ expectedStatus }) => expectedStatus === 201)).toBe(
      true,
    );
  });

  test('creates a validly signed credential whose TURN timestamp is expired', () => {
    const current = Object.freeze({
      username: '1600:opaque',
      credential: 'current-credential',
    });

    expect(
      createExpiredTurnCredentials(current, 'turn-test-secret', 1_000),
    ).toEqual({
      username: '999:opaque',
      credential: 'R7pdd5A+1xfbTUqiHbwHKiILXys=',
    });
    expect(current).toEqual({
      username: '1600:opaque',
      credential: 'current-credential',
    });
  });

  test.each([
    [{ username: 'missing-separator' }, 'turn-test-secret', 1_000],
    [{ username: '1600:' }, 'turn-test-secret', 1_000],
    [{ username: '1600:opaque' }, '', 1_000],
    [{ username: '1600:opaque' }, 'turn-test-secret', 0],
  ])(
    'rejects malformed TURN expiration proof input',
    (credentials, secret, nowSeconds) => {
      expect(() =>
        createExpiredTurnCredentials(credentials, secret, nowSeconds),
      ).toThrow(/expiration proof input is invalid/i);
    },
  );
});
