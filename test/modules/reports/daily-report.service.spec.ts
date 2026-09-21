import { Test } from '@nestjs/testing';
import { OrderStatus, Prisma } from '../../../src/generated/prisma/client';
import { OrdersService } from '../../../src/modules/orders/orders.service';
import { PrismaService } from '../../../src/common/prisma/prisma.service';
import { DailyReportService } from '../../../src/modules/reports/daily-report.service';

const d = (value: string) => new Prisma.Decimal(value);

describe('DailyReportService', () => {
  const prisma = {
    payment: { findMany: jest.fn() },
    refund: { aggregate: jest.fn() },
    $queryRaw: jest.fn(),
  };
  const orders = { findGroupsByOrderIds: jest.fn() };
  let service: DailyReportService;

  const dayStart = new Date('2026-09-02T21:00:00Z');

  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [
        DailyReportService,
        { provide: PrismaService, useValue: prisma },
        { provide: OrdersService, useValue: orders },
      ],
    }).compile();

    service = moduleRef.get(DailyReportService);
  });

  afterEach(() => jest.resetAllMocks());

  it('should count the day payments by the current status of their orders', async () => {
    const paid = (amount: string, status: OrderStatus | null) => ({
      amount: d(amount),
      order: status ? { status } : null,
    });
    prisma.payment.findMany.mockResolvedValue([
      paid('3614.32', OrderStatus.PAID),
      paid('2544.09', OrderStatus.PAID),
      paid('1000', OrderStatus.PARTIALLY_PAID),
      paid('50', OrderStatus.OVERPAID),
      paid('2500', null),
    ]);
    prisma.refund.aggregate.mockResolvedValue({ _count: 1, _sum: { amount: d('50') } });

    const report = await service.build(dayStart);

    expect(prisma.payment.findMany).toHaveBeenCalledWith({
      where: { paidAt: { gte: dayStart, lt: new Date('2026-09-03T21:00:00Z') } },
      select: { amount: true, order: { select: { status: true } } },
    });
    expect(report.paymentsCount).toBe(5);
    expect(report.totalAmount.toFixed(2)).toBe('9708.41');
    expect(report.byBucket).toMatchObject({
      PAID: 2,
      PARTIALLY_PAID: 1,
      OVERPAID: 1,
      UNMATCHED: 1,
    });
    expect(report.refundsCount).toBe(1);
  });

  it('should report an empty day', async () => {
    prisma.payment.findMany.mockResolvedValue([]);
    prisma.refund.aggregate.mockResolvedValue({ _count: 0, _sum: { amount: null } });

    const report = await service.build(dayStart);

    expect(report.paymentsCount).toBe(0);
    expect(report.totalAmount.toFixed(2)).toBe('0.00');
    expect(report.refundsAmount.toFixed(2)).toBe('0.00');
  });

  it('should mark stale partial orders underpaid in one statement and return them', async () => {
    prisma.$queryRaw.mockResolvedValue([{ id: 3 }, { id: 8 }]);
    orders.findGroupsByOrderIds.mockResolvedValue(['group 3', 'group 8']);

    const result = await service.markUnderpaid(dayStart);

    const [strings, ...values] = prisma.$queryRaw.mock.calls[0] as [
      TemplateStringsArray,
      ...unknown[],
    ];
    expect(strings.join('?')).toContain('UPDATE orders');
    expect(strings.join('?')).toContain('base_number');
    expect(values).toEqual(['UNDERPAID', 'PARTIALLY_PAID', dayStart, dayStart]);
    expect(orders.findGroupsByOrderIds).toHaveBeenCalledWith([3, 8]);
    expect(result).toEqual(['group 3', 'group 8']);
  });
});
