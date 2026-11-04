import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { PrismaService } from '../../../src/common/prisma/prisma.service';
import { FinanceSyncModule } from '../../../src/modules/finance-sync/finance-sync.module';
import { FinanceSyncUpdate } from '../../../src/modules/finance-sync/finance-sync.update';
import type { ManagerActionsService } from '../../../src/modules/finance-sync/manager-actions.service';
import type { FinancierActionsService } from '../../../src/modules/finance-sync/financier-actions.service';
import type { RequestCreateService } from '../../../src/modules/finance-sync/request-create.service';
import { ManagersModule } from '../../../src/modules/managers/managers.module';
import { ManagersService } from '../../../src/modules/managers/managers.service';
import { TelegramSender } from '../../../src/modules/telegram/core/telegram-sender';
import { TelegramModule } from '../../../src/modules/telegram/telegram.module';

@Global()
@Module({
  providers: [
    { provide: PrismaService, useValue: {} },
    { provide: ConfigService, useValue: { get: jest.fn() } },
  ],
  exports: [PrismaService, ConfigService],
})
class GlobalStubs {}

@Module({
  providers: [{ provide: ManagersService, useValue: { findActiveByTelegramId: jest.fn() } }],
  exports: [ManagersService],
})
class ManagersStub {}

@Module({
  providers: [{ provide: TelegramSender, useValue: { financeEnabled: true } }],
  exports: [TelegramSender],
})
class TelegramStub {}

describe('FinanceSyncModule', () => {
  it('should wire every provider, given what TelegramModule and ManagersModule export', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [GlobalStubs, FinanceSyncModule] })
      .overrideModule(TelegramModule)
      .useModule(TelegramStub)
      .overrideModule(ManagersModule)
      .useModule(ManagersStub)
      .compile();

    expect(moduleRef.get(FinanceSyncUpdate)).toBeInstanceOf(FinanceSyncUpdate);
  });
});

describe('FinanceSyncUpdate', () => {
  const managers = { findActiveByTelegramId: jest.fn() };
  const requests = { handle: jest.fn() };
  const actions = {
    pressFop: jest.fn(),
    askRate: jest.fn(),
    refresh: jest.fn(),
    onText: jest.fn(),
  };
  const managerActions = { cancel: jest.fn(), onText: jest.fn() };
  const update = new FinanceSyncUpdate(
    managers as unknown as ManagersService,
    requests as unknown as RequestCreateService,
    actions as unknown as FinancierActionsService,
    managerActions as unknown as ManagerActionsService,
  );
  const ctx = (chatType = 'private') => ({
    chat: { type: chatType },
    from: { id: 555 },
    payload: '0000-070217 4972\nдокументи так',
    reply: jest.fn(),
  });

  afterEach(() => jest.resetAllMocks());

  it('should hand an active manager’s payload to the service and reply with its answer', async () => {
    managers.findActiveByTelegramId.mockResolvedValue({ id: 1 });
    requests.handle.mockResolvedValue({ html: 'ok' });
    const c = ctx();

    await update.testRequest(c as never);

    expect(requests.handle).toHaveBeenCalledWith({ id: 1 }, c.payload);
    expect(c.reply).toHaveBeenCalledWith('ok', expect.objectContaining({ parse_mode: 'HTML' }));
  });

  it('should not reply when the service already sent the card', async () => {
    managers.findActiveByTelegramId.mockResolvedValue({ id: 1 });
    requests.handle.mockResolvedValue(null);
    const c = ctx();

    await update.testRequest(c as never);

    expect(c.reply).not.toHaveBeenCalled();
  });

  it('should ignore a group chat', async () => {
    const c = ctx('supergroup');

    await update.testRequest(c as never);

    expect(managers.findActiveByTelegramId).not.toHaveBeenCalled();
    expect(requests.handle).not.toHaveBeenCalled();
  });

  it('should delegate group and manager actions', async () => {
    const c = { match: [] };

    await update.fop(c as never);
    await update.rate(c as never);
    await update.refresh(c as never);
    await update.cancel(c as never);

    expect(actions.pressFop).toHaveBeenCalledWith(c);
    expect(actions.askRate).toHaveBeenCalledWith(c);
    expect(actions.refresh).toHaveBeenCalledWith(c);
    expect(managerActions.cancel).toHaveBeenCalledWith(c);
  });

  describe('text', () => {
    it('should give the financiers first and the manager second, then fall through', async () => {
      const c = {};
      const next = jest.fn();
      actions.onText.mockImplementation((_c: unknown, n: () => Promise<void>) => n());
      managerActions.onText.mockImplementation((_c: unknown, n: () => Promise<void>) => n());

      await update.text(c as never, next);

      expect(actions.onText).toHaveBeenCalledWith(c, expect.any(Function));
      expect(managerActions.onText).toHaveBeenCalledWith(c, next);
      expect(next).toHaveBeenCalledTimes(1);
    });

    it('should not call the manager handler or next when the financiers handled the text', async () => {
      const next = jest.fn();
      actions.onText.mockResolvedValue(undefined);

      await update.text({} as never, next);

      expect(managerActions.onText).not.toHaveBeenCalled();
      expect(next).not.toHaveBeenCalled();
    });
  });
});
