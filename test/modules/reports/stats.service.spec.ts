import { Test } from '@nestjs/testing';
import { kyivDayStartOf, nextKyivDayStart } from '../../../src/common/kyiv-time';
import { Currency, OrderStatus, Prisma } from '../../../src/generated/prisma/client';
import { PrismaService } from '../../../src/common/prisma/prisma.service';
import { StatsService } from '../../../src/modules/reports/stats.service';

const d = (value: string) => new Prisma.Decimal(value);

describe('StatsService', () => {
  const order = { groupBy: jest.fn(), aggregate: jest.fn() };
  const payment = { aggregate: jest.fn(), findMany: jest.fn() };
  const refund = { aggregate: jest.fn() };
  let service: StatsService;

  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [StatsService, { provide: PrismaService, useValue: { order, payment, refund } }],
    }).compile();

    service = moduleRef.get(StatsService);
  });

  afterEach(() => jest.resetAllMocks());

  describe('snapshot', () => {
    beforeEach(() => {
      order.groupBy.mockResolvedValue([
        { status: OrderStatus.PAID, _count: { _all: 3 } },
        { status: OrderStatus.PARTIALLY_PAID, _count: { _all: 2 } },
      ]);
      order.aggregate.mockResolvedValue({ _count: 2, _sum: { amountDue: d('10000') } });
      payment.aggregate.mockImplementation(({ where }: { where: { orderId?: null } }) =>
        Promise.resolve(
          where.orderId === null
            ? { _count: 4, _sum: { amount: d('2500.50') } }
            : { _sum: { amount: d('3000') } },
        ),
      );
      refund.aggregate.mockResolvedValue({ _sum: { amount: d('500') } });
    });

    it('should count orders by status and sum what unpaid orders still owe', async () => {
      const snapshot = await service.snapshot();

      expect(snapshot.statusCounts).toEqual({
        AWAITING_PAYMENT: 0,
        PARTIALLY_PAID: 2,
        UNDERPAID: 0,
        PAID: 3,
        OVERPAID: 0,
        CANCELLED: 0,
      });
      expect(snapshot.outstanding.count).toBe(2);
      expect(snapshot.outstanding.amount.toFixed(2)).toBe('7500.00');
      expect(snapshot.unmatched.count).toBe(4);
      expect(snapshot.unmatched.amount.toFixed(2)).toBe('2500.50');
    });

    it('should count only the orders of the given manager', async () => {
      await service.snapshot(7);

      expect(order.groupBy).toHaveBeenCalledWith({
        by: ['status'],
        where: { managerId: 7 },
        _count: { _all: true },
      });
      expect(payment.aggregate).toHaveBeenCalledWith({
        where: {
          order: {
            status: { in: expect.any(Array) as unknown },
            managerId: 7,
            currency: Currency.UAH,
          },
        },
        _sum: { amount: true },
      });
    });
  });

  describe('period', () => {
    const range = {
      start: kyivDayStartOf('2026-09-10'),
      end: nextKyivDayStart(kyivDayStartOf('2026-09-11')),
    };

    beforeEach(() => {
      payment.findMany.mockResolvedValue([
        {
          amount: d('100'),
          paidAt: new Date('2026-09-10T08:00:00Z'),
          order: { status: OrderStatus.PAID, manager: { id: 1, name: 'Олена' } },
        },
        {
          amount: d('50.50'),
          paidAt: new Date('2026-09-10T21:30:00Z'),
          order: { status: OrderStatus.PARTIALLY_PAID, manager: { id: 2, name: 'Дмитро' } },
        },
        { amount: d('20'), paidAt: new Date('2026-09-11T10:00:00Z'), order: null },
      ]);
      refund.aggregate.mockResolvedValue({ _count: 1, _sum: { amount: d('10') } });
      order.aggregate.mockResolvedValue({ _count: 3, _sum: { amountDue: d('900') } });
    });

    it('should total the payments of the period by status, Kyiv day and manager', async () => {
      const stats = await service.period(range);

      expect(stats.payments.count).toBe(3);
      expect(stats.payments.amount.toFixed(2)).toBe('170.50');
      expect(stats.byBucket).toMatchObject({ PAID: 1, PARTIALLY_PAID: 1, UNMATCHED: 1 });
      expect(stats.daily.map((day) => [day.date, day.count, day.amount.toFixed(2)])).toEqual([
        ['2026-09-10', 1, '100.00'],
        ['2026-09-11', 2, '70.50'],
      ]);
      expect(stats.byManager.map((row) => [row.name, row.amount.toFixed(2)])).toEqual([
        ['Олена', '100.00'],
        ['Дмитро', '50.50'],
      ]);
      expect(stats.refunds.amount.toFixed(2)).toBe('10.00');
      expect(stats.ordersCreated).toMatchObject({ count: 3 });
    });

    it('should report days without payments as zero', async () => {
      payment.findMany.mockResolvedValue([]);

      const stats = await service.period(range);

      expect(stats.daily.map((day) => [day.date, day.count])).toEqual([
        ['2026-09-10', 0],
        ['2026-09-11', 0],
      ]);
    });

    it('should add up hryvnia money only, never mixing in dollars', async () => {
      await service.period(range);

      expect(payment.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ currency: Currency.UAH }) as unknown,
        }),
      );
      expect(refund.aggregate).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            order: expect.objectContaining({ currency: Currency.UAH }) as unknown,
          }) as unknown,
        }),
      );
      expect(order.aggregate).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ currency: Currency.UAH }) as unknown,
        }),
      );
    });

    it('should look only at the orders of the given manager', async () => {
      await service.period(range, 7);

      expect(payment.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            paidAt: { gte: range.start, lt: range.end },
            currency: Currency.UAH,
            order: { managerId: 7 },
          },
        }),
      );
      expect(order.aggregate).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            createdAt: { gte: range.start, lt: range.end },
            managerId: 7,
            currency: Currency.UAH,
          },
        }),
      );
    });
  });
});
