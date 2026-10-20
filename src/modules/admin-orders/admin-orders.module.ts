import { Module } from '@nestjs/common';
import { ThrottlerModule } from '@nestjs/throttler';
import { EXTERNAL_API_THROTTLERS } from '../../common/guards/external-api-throttle';
import { AttachmentsModule } from '../attachments/attachments.module';
import { AdminOrdersController } from './admin-orders.controller';
import { AdminOrdersService } from './admin-orders.service';

@Module({
  imports: [AttachmentsModule, ThrottlerModule.forRoot({ throttlers: EXTERNAL_API_THROTTLERS })],
  controllers: [AdminOrdersController],
  providers: [AdminOrdersService],
  exports: [AdminOrdersService],
})
export class AdminOrdersModule {}
