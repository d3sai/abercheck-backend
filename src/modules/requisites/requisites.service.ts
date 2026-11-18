import { Injectable } from '@nestjs/common';
import { type OrderRequisite, Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import type { Initiator } from '../refunds/refund.events';

export interface RequisiteInput {
  payerName: string;
  account: string | null;
  amount: string;
  /** Null until the payment arrives. */
  paidAt: Date | null;
}

@Injectable()
export class RequisitesService {
  constructor(private readonly prisma: PrismaService) {}

  async addMany(
    orderId: number,
    items: RequisiteInput[],
    addedBy: Initiator,
  ): Promise<OrderRequisite[]> {
    const created: OrderRequisite[] = [];
    for (const item of items) {
      created.push(
        await this.prisma.orderRequisite.create({
          data: {
            orderId,
            payerName: item.payerName,
            account: item.account,
            amount: item.amount,
            paidAt: item.paidAt,
            addedByTelegramId: addedBy.telegramId,
            addedByName: addedBy.name,
          },
        }),
      );
    }
    return created;
  }

  /** The client paid: stamps the date on the payments of `orderIds` that have none yet. */
  async fillPaidAt(orderIds: number[], paidAt: Date): Promise<void> {
    await this.prisma.orderRequisite.updateMany({
      where: { orderId: { in: orderIds }, paidAt: null },
      data: { paidAt },
    });
  }

  /** What the payments of the orders add up to against what the orders are due. */
  async progress(orderIds: number[]): Promise<{ paid: Prisma.Decimal; due: Prisma.Decimal }> {
    const [payments, orders] = await Promise.all([
      this.prisma.orderRequisite.aggregate({
        where: { orderId: { in: orderIds } },
        _sum: { amount: true },
      }),
      this.prisma.order.aggregate({ where: { id: { in: orderIds } }, _sum: { amountDue: true } }),
    ]);
    return {
      paid: payments._sum.amount ?? new Prisma.Decimal(0),
      due: orders._sum.amountDue ?? new Prisma.Decimal(0),
    };
  }

  list(orderId: number): Promise<OrderRequisite[]> {
    return this.prisma.orderRequisite.findMany({
      where: { orderId },
      orderBy: [{ paidAt: 'asc' }, { id: 'asc' }],
    });
  }
}
