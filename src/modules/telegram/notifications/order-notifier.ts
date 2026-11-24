import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { type OrderCreated, OrderEvents } from '../../orders/order.events';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { TelegramSender } from '../core/telegram-sender';
import { OrderVerificationService } from '../verification/order-verification.service';
import { adminOrderCreatedMessage } from './order-templates';

@Injectable()
export class OrderNotifier {
  private readonly logger = new Logger(OrderNotifier.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly sender: TelegramSender,
    private readonly verification: OrderVerificationService,
  ) {}

  @OnEvent(OrderEvents.Created, { async: true })
  async onCreated({ order }: OrderCreated): Promise<void> {
    try {
      const manager = await this.prisma.manager.findUniqueOrThrow({
        where: { id: order.managerId },
      });
      const adminMessageId = await this.sender.sendToAdmins(
        adminOrderCreatedMessage(order, manager),
      );
      if (adminMessageId !== null) {
        await this.prisma.order.update({ where: { id: order.id }, data: { adminMessageId } });
      }
      await this.verification.attachControls([order], adminMessageId);
    } catch (error) {
      this.logger.error(`Failed to notify about order #${order.id}`, error);
    }
  }
}
