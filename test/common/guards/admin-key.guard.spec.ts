import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { EnvironmentVariables } from '../../../src/common/config/env.validation';
import { AdminKeyGuard } from '../../../src/common/guards/admin-key.guard';

const KEY = 'a'.repeat(32);
const EXTERNAL_KEY = 'e'.repeat(32);

const contextWithKey = (key?: string) =>
  ({
    switchToHttp: () => ({
      getRequest: () => ({ header: (name: string) => (name === 'x-api-key' ? key : undefined) }),
    }),
  }) as unknown as ExecutionContext;

const configWith = (adminKey?: string) =>
  ({
    get: (name: string) => (name === 'ADMIN_API_KEY' ? adminKey : EXTERNAL_KEY),
  }) as unknown as ConfigService<EnvironmentVariables, true>;

describe('AdminKeyGuard', () => {
  const guard = new AdminKeyGuard(configWith(KEY));

  it('should allow a request with the configured admin key', () => {
    expect(guard.canActivate(contextWithKey(KEY))).toBe(true);
  });

  it.each([undefined, '', 'wrong', `${KEY}x`, EXTERNAL_KEY])('should reject key %p', (key) => {
    expect(() => guard.canActivate(contextWithKey(key))).toThrow(UnauthorizedException);
  });

  it.each([undefined, ''])('should reject every key when ADMIN_API_KEY is %p', (adminKey) => {
    const disabled = new AdminKeyGuard(configWith(adminKey));

    expect(() => disabled.canActivate(contextWithKey(''))).toThrow(UnauthorizedException);
    expect(() => disabled.canActivate(contextWithKey(KEY))).toThrow(UnauthorizedException);
  });
});
