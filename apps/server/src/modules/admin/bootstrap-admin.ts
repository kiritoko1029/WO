import type { AdminBootstrapRepository } from '@wo/database';
import { emailSchema, passwordSchema } from '@wo/protocol';

import { hashPassword } from '../auth/password.ts';

export async function bootstrapAdmin(
  input: Readonly<{ email: string; password: string }>,
  repository: AdminBootstrapRepository,
): ReturnType<AdminBootstrapRepository['ensure']> {
  const emailNormalized = emailSchema.parse(input.email);
  const password = passwordSchema.parse(input.password);
  const passwordHash = await hashPassword(password);
  return repository.ensure({ emailNormalized, passwordHash });
}
