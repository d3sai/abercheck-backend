import { Module } from '@nestjs/common';
import { AttachmentsModule } from '../attachments/attachments.module';
import { AuthModule } from '../auth/auth.module';
import { ManagersModule } from '../managers/managers.module';
import { OrdersModule } from '../orders/orders.module';
import { PaymentsModule } from '../payments/payments.module';
import { RefundsModule } from '../refunds/refunds.module';
import { ReportsModule } from '../reports/reports.module';
import { RequisitesModule } from '../requisites/requisites.module';
import { CabinetManagersController } from './controllers/cabinet-managers.controller';
import { CabinetOrdersController } from './controllers/cabinet-orders.controller';
import { CabinetPaymentsController } from './controllers/cabinet-payments.controller';
import { CabinetStatsController } from './controllers/cabinet-stats.controller';

@Module({
  imports: [
    AttachmentsModule,
    AuthModule,
    ManagersModule,
    OrdersModule,
    PaymentsModule,
    RefundsModule,
    ReportsModule,
    RequisitesModule,
  ],
  controllers: [
    CabinetOrdersController,
    CabinetPaymentsController,
    CabinetManagersController,
    CabinetStatsController,
  ],
})
export class CabinetModule {}
