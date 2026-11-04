import { Module, forwardRef } from '@nestjs/common';
import { AttachmentsModule } from '../attachments/attachments.module';
import { ManagersModule } from '../managers/managers.module';
import { OrdersModule } from '../orders/orders.module';
import { TelegramModule } from '../telegram/telegram.module';
import { FinanceClient } from './finance.client';
import { FinancierActionsService } from './financier-actions.service';
import { FinanceWebhookController } from './finance-webhook.controller';
import { FinanceWebhookGuard } from './finance-webhook.guard';
import { FinanceSyncUpdate } from './finance-sync.update';
import { ManagerActionsService } from './manager-actions.service';
import { RequestCardsRepository } from './request-cards.repository';
import { RequestCreateService } from './request-create.service';
import { RequestReceiptsService } from './request-receipts.service';
import { RequestSyncService } from './request-sync.service';

@Module({
  // forwardRef: TelegramModule's telegraf `include` lists this module back
  imports: [AttachmentsModule, ManagersModule, OrdersModule, forwardRef(() => TelegramModule)],
  controllers: [FinanceWebhookController],
  providers: [
    FinanceClient,
    FinanceWebhookGuard,
    RequestCardsRepository,
    RequestCreateService,
    RequestSyncService,
    FinancierActionsService,
    ManagerActionsService,
    RequestReceiptsService,
    FinanceSyncUpdate,
  ],
  exports: [
    FinanceClient,
    RequestCardsRepository,
    RequestCreateService,
    RequestReceiptsService,
    RequestSyncService,
  ],
})
export class FinanceSyncModule {}
