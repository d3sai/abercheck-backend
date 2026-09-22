import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import {
  PaymentEvents,
  type PaymentRecorded,
  type PaymentUnmatched,
} from '../../payments/payment-ingestion.types';
import { PrismaService } from '../../../common/prisma/prisma.service';
import {
  type OrderCancelled,
  RefundEvents,
  type RefundRecorded,
} from '../../refunds/refund.events';
import { button } from '../core/bot-reply';
import { TelegramSender } from '../core/telegram-sender';
import {
  adminPaymentMessage,
  managerPaymentMessage,
  needsAdminAttention,
  unknownPaymentMessage,
} from './payment-templates';
import { managerCancelMessage, managerRefundMessage } from './refund-templates';

@Injectable()
export class PaymentNotifier {
  private readonly logger = new Logger(PaymentNotifier.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly sender: TelegramSender,
  ) {}

  @OnEvent(PaymentEvents.Recorded, { async: true })
  async onRecorded({ order, payment, amountPaid }: PaymentRecorded): Promise<void> {
    try {
      const [manager, payments] = await Promise.all([
        this.prisma.manager.findUniqueOrThrow({ where: { id: order.managerId } }),
        this.prisma.payment.findMany({
          where: { order: { baseNumber: order.baseNumber }, id: { lte: payment.id } },
          orderBy: [{ paidAt: 'asc' }, { id: 'asc' }],
        }),
      ]);
      const notice = { order, payment, payments, amountPaid };

      await this.sender.send(manager.telegramId, managerPaymentMessage(notice));
      if (needsAdminAttention(order.status)) {
        await this.sender.sendToAdmins(adminPaymentMessage(notice, manager));
      }
    } catch (error) {
      this.logger.error(`Failed to notify about payment #${payment.id}`, error);
    }
  }

  @OnEvent(PaymentEvents.Unmatched, { async: true })
  async onUnmatched({ payment }: PaymentUnmatched): Promise<void> {
    try {
      await this.sender.sendToAdmins(unknownPaymentMessage(payment), [
        [button("🔗 Прив'язати до замовлення", `attach:${payment.id}`)],
      ]);
    } catch (error) {
      this.logger.error(`Failed to notify about unmatched payment #${payment.id}`, error);
    }
  }

  @OnEvent(RefundEvents.Recorded, { async: true })
  async onRefund(event: RefundRecorded): Promise<void> {
    await this.notifyManager(event.order.managerId, managerRefundMessage(event));
  }

  @OnEvent(RefundEvents.OrderCancelled, { async: true })
  async onCancelled(event: OrderCancelled): Promise<void> {
    await this.notifyManager(event.order.managerId, managerCancelMessage(event));
  }

  private async notifyManager(managerId: number, html: string): Promise<void> {
    try {
      const manager = await this.prisma.manager.findUniqueOrThrow({ where: { id: managerId } });
      await this.sender.send(manager.telegramId, html);
    } catch (error) {
      this.logger.error(`Failed to notify manager #${managerId}`, error);
    }
  }
}
