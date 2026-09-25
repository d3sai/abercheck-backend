import { Injectable } from '@nestjs/common';
import { kyivDate, nextKyivDayStart } from '../../common/kyiv-time';
import { Currency, OrderStatus, Prisma } from '../../generated/prisma/client';
import { UNPAID_STATUSES } from '../orders/order-status';
import { PrismaService } from '../../common/prisma/prisma.service';
import type { ReportBucket } from './daily-report.service';

export interface Totals {
  count: number;
  amount: Prisma.Decimal;
}

export interface Snapshot {
  statusCounts: Record<OrderStatus, number>;
  outstanding: Totals;
  unmatched: Totals;
}

export interface PeriodRange {
  start: Date;
  end: Date;
}

export interface PeriodStats {
  payments: Totals;
  refunds: Totals;
  ordersCreated: Totals;
  byBucket: Record<ReportBucket, number>;
  daily: (Totals & { date: string })[];
  byManager: (Totals & { managerId: number; name: string })[];
}

const zero = () => new Prisma.Decimal(0);

const emptyStatusCounts = () =>
  Object.fromEntries(Object.values(OrderStatus).map((status) => [status, 0])) as Record<
    OrderStatus,
    number
  >;

function add<T extends Totals>(totals: T, amount: Prisma.Decimal): T {
  totals.count += 1;
  totals.amount = totals.amount.plus(amount);
  return totals;
}

@Injectable()
export class StatsService {
  constructor(private readonly prisma: PrismaService) {}

  async snapshot(managerId?: number): Promise<Snapshot> {
    // Money totals are hryvnias only: dollars are a separate currency and never added to them.
    const unpaid = { status: { in: UNPAID_STATUSES }, managerId, currency: Currency.UAH };
    const [groups, due, paid, refunded, unmatched] = await Promise.all([
      this.prisma.order.groupBy({ by: ['status'], where: { managerId }, _count: { _all: true } }),
      this.prisma.order.aggregate({ where: unpaid, _count: true, _sum: { amountDue: true } }),
      this.prisma.payment.aggregate({ where: { order: unpaid }, _sum: { amount: true } }),
      this.prisma.refund.aggregate({ where: { order: unpaid }, _sum: { amount: true } }),
      this.prisma.payment.aggregate({
        where: { orderId: null, currency: Currency.UAH },
        _count: true,
        _sum: { amount: true },
      }),
    ]);

    const statusCounts = emptyStatusCounts();
    for (const group of groups) {
      statusCounts[group.status] = group._count._all;
    }
    const owed = (due._sum.amountDue ?? zero())
      .minus(paid._sum.amount ?? zero())
      .plus(refunded._sum.amount ?? zero());

    return {
      statusCounts,
      outstanding: { count: due._count, amount: owed },
      unmatched: { count: unmatched._count, amount: unmatched._sum.amount ?? zero() },
    };
  }

  async period({ start, end }: PeriodRange, managerId?: number): Promise<PeriodStats> {
    const window = { gte: start, lt: end };
    const ofManager = managerId === undefined ? {} : { order: { managerId } };
    const [payments, refunds, created] = await Promise.all([
      this.prisma.payment.findMany({
        where: { paidAt: window, currency: Currency.UAH, ...ofManager },
        select: {
          amount: true,
          paidAt: true,
          order: { select: { status: true, manager: { select: { id: true, name: true } } } },
        },
      }),
      this.prisma.refund.aggregate({
        where: { createdAt: window, order: { managerId, currency: Currency.UAH } },
        _count: true,
        _sum: { amount: true },
      }),
      this.prisma.order.aggregate({
        where: { createdAt: window, managerId, currency: Currency.UAH },
        _count: true,
        _sum: { amountDue: true },
      }),
    ]);

    const byBucket: Record<ReportBucket, number> = { ...emptyStatusCounts(), UNMATCHED: 0 };
    const daily = new Map<string, Totals>();
    for (let day = start; day.getTime() < end.getTime(); day = nextKyivDayStart(day)) {
      daily.set(kyivDate(day), { count: 0, amount: zero() });
    }
    const byManager = new Map<number, Totals & { managerId: number; name: string }>();
    const total: Totals = { count: 0, amount: zero() };

    for (const { amount, paidAt, order } of payments) {
      add(total, amount);
      byBucket[order?.status ?? 'UNMATCHED'] += 1;
      const day = daily.get(kyivDate(paidAt));
      if (day) {
        add(day, amount);
      }
      if (order) {
        const { id, name } = order.manager;
        const entry = byManager.get(id) ?? { managerId: id, name, count: 0, amount: zero() };
        byManager.set(id, add(entry, amount));
      }
    }

    return {
      payments: total,
      refunds: { count: refunds._count, amount: refunds._sum.amount ?? zero() },
      ordersCreated: { count: created._count, amount: created._sum.amountDue ?? zero() },
      byBucket,
      daily: [...daily].map(([date, totals]) => ({ date, ...totals })),
      byManager: [...byManager.values()].sort((a, b) => b.amount.comparedTo(a.amount)),
    };
  }
}
