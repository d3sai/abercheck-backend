import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { PrismaService } from '../../../src/common/prisma/prisma.service';
import { FinanceSyncModule } from '../../../src/modules/finance-sync/finance-sync.module';
import { AttachmentsModule } from '../../../src/modules/attachments/attachments.module';
import { AttachmentsService } from '../../../src/modules/attachments/attachments.service';
import { ManagersModule } from '../../../src/modules/managers/managers.module';
import { ManagersService } from '../../../src/modules/managers/managers.service';
import { MiniappController } from '../../../src/modules/miniapp/miniapp.controller';
import { MiniappModule } from '../../../src/modules/miniapp/miniapp.module';
import { OrdersModule } from '../../../src/modules/orders/orders.module';
import { OrdersService } from '../../../src/modules/orders/orders.service';
import { RequisitesModule } from '../../../src/modules/requisites/requisites.module';
import { RequisitesService } from '../../../src/modules/requisites/requisites.service';
import { DirectOrdersService } from '../../../src/modules/miniapp/direct-orders.service';
import { MiniappUpdate } from '../../../src/modules/miniapp/miniapp.update';
import { RequestCompletionService } from '../../../src/modules/miniapp/request-completion.service';
import { CashDraftService } from '../../../src/modules/telegram/order-draft/cash-draft.service';
import { ForeignDraftService } from '../../../src/modules/telegram/order-draft/foreign-draft.service';
import { KitDraftService } from '../../../src/modules/telegram/order-draft/kit-draft.service';
import { TelegramSender } from '../../../src/modules/telegram/core/telegram-sender';
import { OrderDraftService } from '../../../src/modules/telegram/order-draft/order-draft.service';
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
  providers: [
    { provide: TelegramSender, useValue: { financeEnabled: true } },
    { provide: OrderDraftService, useValue: { isArmed: () => false } },
    { provide: KitDraftService, useValue: {} },
    { provide: CashDraftService, useValue: {} },
    { provide: ForeignDraftService, useValue: {} },
  ],
  exports: [
    TelegramSender,
    KitDraftService,
    CashDraftService,
    ForeignDraftService,
    OrderDraftService,
  ],
})
class TelegramStub {}

@Module({
  providers: [{ provide: OrdersService, useValue: {} }],
  exports: [OrdersService],
})
class OrdersStub {}

@Module({
  providers: [{ provide: RequisitesService, useValue: {} }],
  exports: [RequisitesService],
})
class RequisitesStub {}

@Module({
  providers: [{ provide: AttachmentsService, useValue: {} }],
  exports: [AttachmentsService],
})
class AttachmentsStub {}

describe('MiniappModule', () => {
  it('should wire the controller from what FinanceSyncModule and the order modules export', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [GlobalStubs, FinanceSyncModule, MiniappModule],
    })
      .overrideModule(TelegramModule)
      .useModule(TelegramStub)
      .overrideModule(OrdersModule)
      .useModule(OrdersStub)
      .overrideModule(RequisitesModule)
      .useModule(RequisitesStub)
      .overrideModule(ManagersModule)
      .useModule(ManagersStub)
      .overrideModule(AttachmentsModule)
      .useModule(AttachmentsStub)
      .compile();

    expect(moduleRef.get(MiniappController)).toBeInstanceOf(MiniappController);
    expect(moduleRef.get(RequestCompletionService)).toBeInstanceOf(RequestCompletionService);
    expect(moduleRef.get(DirectOrdersService)).toBeInstanceOf(DirectOrdersService);
    expect(moduleRef.get(MiniappUpdate)).toBeInstanceOf(MiniappUpdate);
  });
});
