import { Injectable } from '@nestjs/common';
import { nextKyivDayStart } from '../../common/kyiv-time';
import { Currency, OrderStatus, Prisma } from '../../generated/prisma/client';
import { type OrderWithManager, type OrderWithPaid, OrdersService } from '../orders/orders.service';
import { PrismaService } from '../../common/prisma/prisma.service';

export type ReportBucket = OrderStatus | 'UNMATCHED';

export interface DailyReport {
  dayStart: Date;
  paymentsCount: number;
  totalAmount: Prisma.Decimal;
  byBucket: Record<ReportBucket, number>;
  refundsCount: number;
  refundsAmount: Prisma.Decimal;
  // The dollar side of the same figures; the fields above are hryvnias only.
  usd: { paymentsAmount: Prisma.Decimal; refundsCount: number; refundsAmount: Prisma.Decimal };
}

const emptyBuckets = (): Record<ReportBucket, number> => ({
  AWAITING_PAYMENT: 0,
  PARTIALLY_PAID: 0,
  UNDERPAID: 0,
  PAID: 0,
  OVERPAID: 0,
  CANCELLED: 0,
  UNMATCHED: 0,
});

@Injectable()
export class DailyReportService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly orders: OrdersService,
  ) {}

  async build(dayStart: Date): Promise<DailyReport> {
    const window = { gte: dayStart, lt: nextKyivDayStart(dayStart) };
    const [payments, refunds] = await Promise.all([
      this.prisma.payment.findMany({
        where: { paidAt: window },
        select: { amount: true, currency: true, order: { select: { status: true } } },
      }),
      this.prisma.refund.findMany({
        where: { createdAt: window },
        select: { amount: true, order: { select: { currency: true } } },
      }),
    ]);

    const zero = new Prisma.Decimal(0);
    const usd = { paymentsAmount: zero, refundsCount: 0, refundsAmount: zero };
    const byBucket = emptyBuckets();
    let totalAmount = zero;
    for (const payment of payments) {
      byBucket[payment.order?.status ?? 'UNMATCHED'] += 1;
      if (payment.currency === Currency.USD) {
        usd.paymentsAmount = usd.paymentsAmount.plus(payment.amount);
      } else {
        totalAmount = totalAmount.plus(payment.amount);
      }
    }
    let refundsCount = 0;
    let refundsAmount = zero;
    for (const refund of refunds) {
      if (refund.order.currency === Currency.USD) {
        usd.refundsCount += 1;
        usd.refundsAmount = usd.refundsAmount.plus(refund.amount);
      } else {
        refundsCount += 1;
        refundsAmount = refundsAmount.plus(refund.amount);
      }
    }

    return {
      dayStart,
      paymentsCount: payments.length,
      totalAmount,
      byBucket,
      refundsCount,
      refundsAmount,
      usd,
    };
  }

  async markUnderpaid(todayStart: Date): Promise<OrderWithPaid<OrderWithManager>[]> {
    const rows = await this.prisma.$queryRaw<{ id: number }[]>`
      UPDATE orders o
      SET status = ${OrderStatus.UNDERPAID}::order_status, updated_at = now()
      WHERE o.status = ${OrderStatus.PARTIALLY_PAID}::order_status
        AND NOT EXISTS (
          SELECT 1 FROM payments p JOIN orders po ON po.id = p.order_id
          WHERE po.base_number = o.base_number AND p.paid_at >= ${todayStart})
        AND NOT EXISTS (
          SELECT 1 FROM refunds r JOIN orders ro ON ro.id = r.order_id
          WHERE ro.base_number = o.base_number AND r.created_at >= ${todayStart})
      RETURNING o.id`;
    return this.orders.findGroupsByOrderIds(rows.map((row) => row.id));
  }
}
