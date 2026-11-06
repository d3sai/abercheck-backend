import { Module } from '@nestjs/common';
import { FinanceSyncModule } from '../finance-sync/finance-sync.module';
import { ManagersModule } from '../managers/managers.module';
import { OrdersModule } from '../orders/orders.module';
import { RequisitesModule } from '../requisites/requisites.module';
import { TelegramModule } from '../telegram/telegram.module';
import { DirectOrdersService } from './direct-orders.service';
import { MiniappAuthGuard } from './miniapp-auth.guard';
import { MiniappController } from './miniapp.controller';
import { RequestCompletionService } from './request-completion.service';

@Module({
  imports: [
    ManagersModule,
    FinanceSyncModule,
    OrdersModule,
    RequisitesModule,
    // provides TelegramSender, which edits the manager card and writes the admin notice
    TelegramModule,
  ],
  controllers: [MiniappController],
  providers: [MiniappAuthGuard, RequestCompletionService, DirectOrdersService],
})
export class MiniappModule {}
