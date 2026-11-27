import { Injectable } from '@nestjs/common';
import { OrderStatus } from '../../../generated/prisma/client';
import { OrdersService } from '../../orders/orders.service';
import { PaymentsService } from '../../payments/payments.service';
import { type BotReply, PAGE_SIZE, pageCount } from '../core/bot-reply';
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

  async forManager(managerId: number, page: number): Promise<BotReply> {
    const at = (index: number) =>
      this.orders.search({
        managerId,
        statuses: OPEN_STATUSES,
        sort: 'createdAt',
        direction: 'desc',
        skip: index * PAGE_SIZE,
        take: PAGE_SIZE,
      });
    let index = Math.max(page, 0);
    let { items, total } = await at(index);
    // orders got paid since the list was drawn: the asked page is gone, show the last one
    if (index > 0 && index >= pageCount(total)) {
      index = pageCount(total) - 1;
      ({ items, total } = await at(index));
    }
    return orderList({
      title: 'Мої відкриті замовлення',
      items,
      total,
      withManager: false,
      page: { index, pages: pageCount(total), prefix: 'mol' },
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
