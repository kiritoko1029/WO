import { describe, expect, test, vi } from 'vitest';
import type { AdminBootstrapRepository } from '@wo/database';
import { bootstrapAdmin } from '../src/modules/admin/bootstrap-admin.ts';
import { verifyPassword } from '../src/modules/auth/password.ts';

describe('administrator bootstrap boundary', () => {
  test('normalizes the administrator and hashes the password before persistence', async () => {
    const result = {
      state: 'created' as const,
      userId: '11111111-1111-4111-8111-111111111111',
    };
    const ensure = vi.fn<AdminBootstrapRepository['ensure']>(
      async () => result,
    );
    expect(
      await bootstrapAdmin(
        { email: ' Admin@Example.com ', password: 'secret-test-password' },
        { ensure },
      ),
    ).toEqual(result);
    const input = ensure.mock.calls[0]![0];
    expect(input.emailNormalized).toBe('admin@example.com');
    expect(input.passwordHash).not.toContain('secret-test-password');
    expect(
      await verifyPassword(input.passwordHash, 'secret-test-password'),
    ).toBe(true);
  });
  test('invalid input never reaches persistence', async () => {
    const ensure = vi.fn();
    await expect(
      bootstrapAdmin({ email: 'bad-email', password: 'short' }, { ensure }),
    ).rejects.toThrow();
    expect(ensure).not.toHaveBeenCalled();
  });
});
