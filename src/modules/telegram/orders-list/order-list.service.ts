import { Injectable } from '@nestjs/common';
import { OrderStatus } from '../../../generated/prisma/client';
import { OrdersService } from '../../orders/orders.service';
import { PaymentsService } from '../../payments/payments.service';
import type { BotReply } from '../core/bot-reply';
import { LIST_LIMIT, orderList, UNMATCHED_LIMIT } from './orders-list.messages';

const OPEN_STATUSES = [
  OrderStatus.AWAITING_PAYMENT,
  OrderStatus.PARTIALLY_PAID,
  OrderStatus.UNDERPAID,
  OrderStatus.OVERPAID,
];

@Injectable()
export class OrderListService {
  constructor(
    private readonly orders: OrdersService,
    private readonly payments: PaymentsService,
  ) {}

  async forManager(managerId: number, all: boolean): Promise<BotReply> {
    const { items, total } = await this.orders.list(
      { managerId, statuses: all ? undefined : OPEN_STATUSES },
      LIST_LIMIT,
    );
    return orderList({
      title: all ? 'Мої замовлення' : 'Мої відкриті замовлення',
      items,
      total,
      withManager: false,
      deletable: items
        .filter(
          ({ order, amountPaid }) =>
            order.status === OrderStatus.AWAITING_PAYMENT && amountPaid.isZero(),
        )
        .map(({ order }) => order.orderNumber),
    });
  }

  async forAdmins(all: boolean): Promise<BotReply> {
    const [{ items, total }, unmatched] = await Promise.all([
      this.orders.list({ statuses: all ? undefined : OPEN_STATUSES }, LIST_LIMIT),
      this.payments.findUnmatched(UNMATCHED_LIMIT),
    ]);
    return orderList({
      title: all ? 'Усі замовлення' : 'Відкриті замовлення',
      items,
      total,
      withManager: true,
      unmatched,
    });
  }
}
