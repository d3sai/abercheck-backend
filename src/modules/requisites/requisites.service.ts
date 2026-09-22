import { Injectable } from '@nestjs/common';
import type { OrderRequisite } from '../../generated/prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import type { Initiator } from '../refunds/refund.events';

// One requisite line as typed by a manager: who paid, through which account (card/IBAN/etc), how
// much and when. Parsing (from a chat message) lives with the callers; this module only stores it.
export interface RequisiteInput {
  payerName: string;
  /** Card, IBAN, or whatever identifies the account — not always known from a free-text report. */
  account: string | null;
  amount: string;
  paidAt: Date;
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

  list(orderId: number): Promise<OrderRequisite[]> {
    return this.prisma.orderRequisite.findMany({
      where: { orderId },
      orderBy: [{ paidAt: 'asc' }, { id: 'asc' }],
    });
  }
}
