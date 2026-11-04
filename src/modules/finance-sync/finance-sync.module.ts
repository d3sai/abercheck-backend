import { Module, forwardRef } from '@nestjs/common';
import { ManagersModule } from '../managers/managers.module';
import { TelegramModule } from '../telegram/telegram.module';
import { FinanceClient } from './finance.client';
import { FinancierActionsService } from './financier-actions.service';
import { FinanceWebhookController } from './finance-webhook.controller';
import { FinanceWebhookGuard } from './finance-webhook.guard';
import { FinanceSyncUpdate } from './finance-sync.update';
import { ManagerActionsService } from './manager-actions.service';
import { RequestCardsRepository } from './request-cards.repository';
import { RequestCreateService } from './request-create.service';
import { RequestSyncService } from './request-sync.service';

@Module({
  // forwardRef: TelegramModule's telegraf `include` lists this module back
  imports: [ManagersModule, forwardRef(() => TelegramModule)],
  controllers: [FinanceWebhookController],
  providers: [
    FinanceClient,
    FinanceWebhookGuard,
    RequestCardsRepository,
    RequestCreateService,
    RequestSyncService,
    FinancierActionsService,
    ManagerActionsService,
    FinanceSyncUpdate,
  ],
  exports: [FinanceClient, RequestCardsRepository, RequestSyncService],
})
export class FinanceSyncModule {}
