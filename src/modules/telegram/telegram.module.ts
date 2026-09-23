import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TelegrafModule } from 'nestjs-telegraf';
import type { EnvironmentVariables } from '../../common/config/env.validation';
import { AttachmentsModule } from '../attachments/attachments.module';
import { ManagersModule } from '../managers/managers.module';
import { OrdersModule } from '../orders/orders.module';
import { PaymentsModule } from '../payments/payments.module';
import { RefundsModule } from '../refunds/refunds.module';
import { RequisitesModule } from '../requisites/requisites.module';
import { ReportsModule } from '../reports/reports.module';
import { AccessNotifier } from './access/access-notifier';
import { AdminFlowService } from './admin/admin-flow.service';
import { AdminUpdate } from './admin/admin.update';
import { BotLauncher } from './core/bot-launcher';
import { BotUpdate } from './core/bot.update';
import { DailyReportJob } from './reports/daily-report.job';
import { OrderNotifier } from './notifications/order-notifier';
import { PaymentNotifier } from './notifications/payment-notifier';
import { DraftAttachmentNotifier } from './order-draft/draft-attachment-notifier';
import { OrderCreationFlowService } from './order-draft/order-creation-flow.service';
import { OrderDraftService } from './order-draft/order-draft.service';
import { PartOfferStore } from './order-draft/part-offer.store';
import { PendingFilesStore } from './order-draft/pending-files.store';
import { RequisitesDraftService } from './order-draft/requisites-draft.service';
import { RequisitesDraftStore } from './order-draft/requisites-draft.store';
import { OrderListService } from './orders-list/order-list.service';
import { TelegramSender } from './core/telegram-sender';

@Module({
  imports: [
    TelegrafModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService<EnvironmentVariables, true>) => ({
        token: config.get('TELEGRAM_BOT_TOKEN', { infer: true }),
        include: [TelegramModule],
        launchOptions: false,
      }),
    }),
    AttachmentsModule,
    ManagersModule,
    OrdersModule,
    PaymentsModule,
    RefundsModule,
    ReportsModule,
    RequisitesModule,
  ],
  providers: [
    BotLauncher,
    BotUpdate,
    AdminUpdate,
    TelegramSender,
    PaymentNotifier,
    OrderNotifier,
    AccessNotifier,
    PendingFilesStore,
    PartOfferStore,
    RequisitesDraftStore,
    DraftAttachmentNotifier,
    OrderCreationFlowService,
    RequisitesDraftService,
    OrderDraftService,
    OrderListService,
    AdminFlowService,
    DailyReportJob,
  ],
})
export class TelegramModule {}
