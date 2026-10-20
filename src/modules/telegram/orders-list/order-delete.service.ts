import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { type Manager, OrderStatus } from '../../../generated/prisma/client';
import { AdminOrdersService } from '../../admin-orders/admin-orders.service';
import { normalizePartNumber } from '../../orders/order-number';
import { type BotReply, button } from '../core/bot-reply';
import { escapeHtml, formatMoneyIn } from '../core/format';
import { TelegramSender } from '../core/telegram-sender';

export const DeleteAction = {
  Ask: /^del:(.+)$/,
  Confirm: /^delok:(.+):(\d+)$/,
  Dismiss: 'delno',
} as const;

const NOT_DELETABLE: BotReply = {
  html: '⚠️ Це замовлення не можна видалити самостійно: воно чуже, уже має оплату чи повернення, або його вже немає. Зверніться до адміністратора.',
};

@Injectable()
export class OrderDeleteService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly adminOrders: AdminOrdersService,
    private readonly sender: TelegramSender,
  ) {}

  // originId: the message whose keyboard to clear after deletion, 0 to leave it alone
  async ask(manager: Manager, rawNumber: string, originId: number): Promise<BotReply> {
    const order = await this.findDeletable(manager, rawNumber);
    if (!order) {
      return NOT_DELETABLE;
    }
    return {
      html: [
        `🗑 Видалити замовлення № <b>${escapeHtml(order.orderNumber)}</b>?`,
        `${escapeHtml(order.clientName)} · ${formatMoneyIn(order.amountDue, order.currency)}`,
        '',
        'Це незворотно: замовлення зникне з бази й з чату адміністраторів.',
      ].join('\n'),
      buttons: [
        [
          button('🗑 Так, видалити', `delok:${order.orderNumber}:${originId}`),
          button('✖ Ні', DeleteAction.Dismiss),
        ],
      ],
    };
  }

  async confirm(manager: Manager, rawNumber: string): Promise<BotReply> {
    const order = await this.findDeletable(manager, rawNumber);
    if (!order) {
      return NOT_DELETABLE;
    }
    // detach, not delete: a payment that lands after the check above must survive as unmatched
    await this.adminOrders.remove(
      order.orderNumber,
      { confirm: order.orderNumber, payments: 'detach' },
      `manager:${manager.name}`,
    );
    const messageIds = [
      ...(order.adminMessageId === null ? [] : [order.adminMessageId]),
      ...order.attachments.map((file) => file.telegramMessageId),
    ];
    await Promise.all(messageIds.map((id) => this.sender.deleteAdminMessage(id)));
    return { html: `🗑 Замовлення № <b>${escapeHtml(order.orderNumber)}</b> видалено.` };
  }

  private async findDeletable(manager: Manager, rawNumber: string) {
    const order = await this.prisma.order.findUnique({
      where: { orderNumber: normalizePartNumber(rawNumber) },
      include: {
        // the bot keeps these in the admin chat when an order is deleted from the API
        attachments: { where: { keepMessageOnDelete: true }, select: { telegramMessageId: true } },
        _count: { select: { payments: true, refunds: true } },
      },
    });
    const deletable =
      order !== null &&
      order.managerId === manager.id &&
      order.status === OrderStatus.AWAITING_PAYMENT &&
      order._count.payments === 0 &&
      order._count.refunds === 0;
    return deletable ? order : null;
  }
}
