import type { ExecutionContext } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { ApiError } from '../../../src/common/api-error';
import type { ManagersService } from '../../../src/modules/managers/managers.service';
import { verifyInitData } from '../../../src/modules/miniapp/init-data';
import {
  MINIAPP_INIT_DATA_HEADER,
  MiniappAuthGuard,
} from '../../../src/modules/miniapp/miniapp-auth.guard';

jest.mock('../../../src/modules/miniapp/init-data');

const verify = jest.mocked(verifyInitData);

function contextFor(initData?: string) {
  const request: { manager?: unknown; header: (name: string) => string | undefined } = {
    header: (name) => (name === MINIAPP_INIT_DATA_HEADER ? initData : undefined),
  };
  const context = {
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
  return { context, request };
}

async function failure(promise: Promise<unknown>): Promise<{ status: number; code: string }> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ApiError) {
      return { status: error.getStatus(), code: (error.getResponse() as { code: string }).code };
    }
    throw error;
  }
  throw new Error('Expected the guard to reject');
}

describe('MiniappAuthGuard', () => {
  const managers = { findActiveByTelegramId: jest.fn() };
  const config = { get: jest.fn().mockReturnValue('123:token') };
  const guard = new MiniappAuthGuard(
    config as unknown as ConfigService<never, true>,
    managers as unknown as ManagersService,
  );
  const manager = { id: 7 };

  afterEach(() => jest.resetAllMocks().mocked(config.get).mockReturnValue('123:token'));

  it('should answer 401 init-data-invalid when the header is missing', async () => {
    await expect(failure(guard.canActivate(contextFor().context))).resolves.toEqual({
      status: 401,
      code: 'init-data-invalid',
    });
    expect(verify).not.toHaveBeenCalled();
  });

  it('should answer 401 init-data-invalid when verification fails', async () => {
    verify.mockReturnValue({ ok: false, reason: 'bad-hash' });

    await expect(failure(guard.canActivate(contextFor('raw').context))).resolves.toEqual({
      status: 401,
      code: 'init-data-invalid',
    });
    expect(managers.findActiveByTelegramId).not.toHaveBeenCalled();
  });

  it('should answer 403 not-a-manager when there is no active manager', async () => {
    verify.mockReturnValue({ ok: true, telegramId: 5n, authDate: new Date() });
    managers.findActiveByTelegramId.mockResolvedValue(null);

    await expect(failure(guard.canActivate(contextFor('raw').context))).resolves.toEqual({
      status: 403,
      code: 'not-a-manager',
    });
    expect(managers.findActiveByTelegramId).toHaveBeenCalledWith(5n);
  });

  it('should set request.manager and allow the call', async () => {
    verify.mockReturnValue({ ok: true, telegramId: 5n, authDate: new Date() });
    managers.findActiveByTelegramId.mockResolvedValue(manager);
    const { context, request } = contextFor('raw');

    await expect(guard.canActivate(context)).resolves.toBe(true);

    expect(request.manager).toBe(manager);
    expect(verify).toHaveBeenCalledWith('raw', '123:token', expect.any(Date));
  });
});
