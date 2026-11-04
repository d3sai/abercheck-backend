import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { PrismaService } from '../../../src/common/prisma/prisma.service';
import { FinanceSyncModule } from '../../../src/modules/finance-sync/finance-sync.module';
import { FinanceSyncUpdate } from '../../../src/modules/finance-sync/finance-sync.update';
import type { ManagerActionsService } from '../../../src/modules/finance-sync/manager-actions.service';
import type { RequestReceiptsService } from '../../../src/modules/finance-sync/request-receipts.service';
import type { FinancierActionsService } from '../../../src/modules/finance-sync/financier-actions.service';
import { AttachmentsModule } from '../../../src/modules/attachments/attachments.module';
import { AttachmentsService } from '../../../src/modules/attachments/attachments.service';
import { ManagersModule } from '../../../src/modules/managers/managers.module';
import { ManagersService } from '../../../src/modules/managers/managers.service';
import { OrdersModule } from '../../../src/modules/orders/orders.module';
import { OrdersService } from '../../../src/modules/orders/orders.service';
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

@Module({
  providers: [{ provide: AttachmentsService, useValue: {} }],
  exports: [AttachmentsService],
})
class AttachmentsStub {}

@Module({
  providers: [{ provide: OrdersService, useValue: {} }],
  exports: [OrdersService],
})
class OrdersStub {}

describe('FinanceSyncModule', () => {
  it('should wire every provider, given what TelegramModule and ManagersModule export', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [GlobalStubs, FinanceSyncModule] })
      .overrideModule(TelegramModule)
      .useModule(TelegramStub)
      .overrideModule(ManagersModule)
      .useModule(ManagersStub)
      .overrideModule(AttachmentsModule)
      .useModule(AttachmentsStub)
      .overrideModule(OrdersModule)
      .useModule(OrdersStub)
      .compile();

    expect(moduleRef.get(FinanceSyncUpdate)).toBeInstanceOf(FinanceSyncUpdate);
  });
});

describe('FinanceSyncUpdate', () => {
  const actions = {
    pressFop: jest.fn(),
    askRate: jest.fn(),
    refresh: jest.fn(),
    onText: jest.fn(),
  };
  const managerActions = { cancel: jest.fn(), onText: jest.fn() };
  const receipts = { onFile: jest.fn() };
  const update = new FinanceSyncUpdate(
    actions as unknown as FinancierActionsService,
    managerActions as unknown as ManagerActionsService,
    receipts as unknown as RequestReceiptsService,
  );
  afterEach(() => jest.resetAllMocks());

  it('should no longer register the /testrequest command', () => {
    expect(Object.getOwnPropertyNames(FinanceSyncUpdate.prototype)).not.toContain('testRequest');
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

  describe('files', () => {
    it('should hand a document to the receipts service as a TelegramFileRef', async () => {
      const c = {
        message: {
          document: {
            file_id: 'd1',
            file_name: 'a.pdf',
            mime_type: 'application/pdf',
            file_size: 7,
          },
        },
      };
      const next = jest.fn();

      await update.document(c as never, next);

      expect(receipts.onFile).toHaveBeenCalledWith(
        c,
        { fileId: 'd1', filename: 'a.pdf', mimeType: 'application/pdf', size: 7, kind: 'document' },
        next,
      );
    });

    it('should hand the largest photo size to the receipts service', async () => {
      const c = {
        message: {
          photo: [
            { file_id: 's', file_size: 1 },
            { file_id: 'l', file_size: 9 },
          ],
        },
      };
      const next = jest.fn();

      await update.photo(c as never, next);

      expect(receipts.onFile).toHaveBeenCalledWith(
        c,
        { fileId: 'l', filename: 'photo.jpg', mimeType: 'image/jpeg', size: 9, kind: 'photo' },
        next,
      );
    });

    it('should call next when the update carries no file', async () => {
      const next = jest.fn();

      await update.document({ message: { text: 'x' } } as never, next);
      await update.photo({ message: { text: 'x' } } as never, next);

      expect(next).toHaveBeenCalledTimes(2);
      expect(receipts.onFile).not.toHaveBeenCalled();
    });
  });
});
