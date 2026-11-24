import { Module, forwardRef } from '@nestjs/common';
import { AttachmentsModule } from '../attachments/attachments.module';
import { FinanceSyncModule } from '../finance-sync/finance-sync.module';
import { ManagersModule } from '../managers/managers.module';
import { OrdersModule } from '../orders/orders.module';
import { RequisitesModule } from '../requisites/requisites.module';
import { TelegramModule } from '../telegram/telegram.module';
import { DirectOrdersService } from './direct-orders.service';
import { MiniappAuthGuard } from './miniapp-auth.guard';
import { MiniappController } from './miniapp.controller';
import { MiniappUpdate } from './miniapp.update';
import { PendingOrdersService } from './pending-orders.service';
import { RequestCompletionService } from './request-completion.service';

@Module({
  imports: [
    AttachmentsModule,
    ManagersModule,
    // forwardRef: FinanceSyncModule loads TelegramModule, which lists this module in its `include`
    forwardRef(() => FinanceSyncModule),
    OrdersModule,
    RequisitesModule,
    // provides TelegramSender, which edits the manager card and writes the admin notice;
    // forwardRef: TelegramModule's telegraf `include` lists this module back
    forwardRef(() => TelegramModule),
  ],
  controllers: [MiniappController],
  providers: [
    MiniappAuthGuard,
    RequestCompletionService,
    DirectOrdersService,
    PendingOrdersService,
    MiniappUpdate,
  ],
})
export class MiniappModule {}
