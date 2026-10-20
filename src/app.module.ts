import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { ScheduleModule } from '@nestjs/schedule';
import { AdminOrdersModule } from './modules/admin-orders/admin-orders.module';
import { AuthModule } from './modules/auth/auth.module';
import { CabinetModule } from './modules/cabinet/cabinet.module';
import { validateEnv } from './common/config/env.validation';
import { HealthModule } from './modules/health/health.module';
import { ManagersModule } from './modules/managers/managers.module';
import { OrdersModule } from './modules/orders/orders.module';
import { PaymentsModule } from './modules/payments/payments.module';
import { PrismaModule } from './common/prisma/prisma.module';
import { TelegramModule } from './modules/telegram/telegram.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, validate: validateEnv }),
    EventEmitterModule.forRoot(),
    ScheduleModule.forRoot(),
    PrismaModule,
    AdminOrdersModule,
    AuthModule,
    CabinetModule,
    HealthModule,
    ManagersModule,
    OrdersModule,
    PaymentsModule,
    TelegramModule,
  ],
})
export class AppModule {}
