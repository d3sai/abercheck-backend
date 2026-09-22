import { type Manager, ManagerStatus } from '../../../../src/generated/prisma/client';
import { AccessNotifier } from '../../../../src/modules/telegram/access/access-notifier';
import type { TelegramSender } from '../../../../src/modules/telegram/core/telegram-sender';

const manager = (overrides: Partial<Manager> = {}): Manager => ({
  id: 1,
  telegramId: 5000000000n,
  name: 'Христина',
  username: 'khrystyna',
  status: ManagerStatus.ACTIVE,
  role: 'MANAGER',
  login: null,
  passwordHash: null,
  sessionVersion: 0,
  createdAt: new Date(),
  ...overrides,
});

describe('AccessNotifier', () => {
  const sender = { send: jest.fn() };
  let notifier: AccessNotifier;

  beforeEach(() => {
    notifier = new AccessNotifier(sender as unknown as TelegramSender);
  });

  afterEach(() => jest.resetAllMocks());

  it('should notify an approved manager with the menu attached', async () => {
    await notifier.onAccessChanged({
      manager: manager({ status: ManagerStatus.ACTIVE }),
      previousStatus: ManagerStatus.PENDING,
    });

    expect(sender.send).toHaveBeenCalledWith(
      5000000000n,
      expect.stringContaining('Доступ надано'),
      undefined,
      true,
    );
  });

  it('should notify a rejected manager without the menu', async () => {
    await notifier.onAccessChanged({
      manager: manager({ status: ManagerStatus.REJECTED }),
      previousStatus: ManagerStatus.PENDING,
    });

    expect(sender.send).toHaveBeenCalledWith(
      5000000000n,
      expect.stringContaining('відхилено'),
      undefined,
      false,
    );
  });

  it('should not send anything while the request is still pending', async () => {
    await notifier.onAccessChanged({
      manager: manager({ status: ManagerStatus.PENDING }),
      previousStatus: ManagerStatus.PENDING,
    });

    expect(sender.send).not.toHaveBeenCalled();
  });

  it('should swallow a failed send instead of throwing', async () => {
    sender.send.mockRejectedValue(new Error('bot was blocked by the user'));

    await expect(
      notifier.onAccessChanged({
        manager: manager({ status: ManagerStatus.ACTIVE }),
        previousStatus: ManagerStatus.PENDING,
      }),
    ).resolves.toBeUndefined();
  });
});
