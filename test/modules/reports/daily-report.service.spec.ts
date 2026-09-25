import { Test } from '@nestjs/testing';
import { Currency, OrderStatus, Prisma } from '../../../src/generated/prisma/client';
import { OrdersService } from '../../../src/modules/orders/orders.service';
import { PrismaService } from '../../../src/common/prisma/prisma.service';
import { DailyReportService } from '../../../src/modules/reports/daily-report.service';

const d = (value: string) => new Prisma.Decimal(value);

describe('DailyReportService', () => {
  const prisma = {
    payment: { findMany: jest.fn() },
    refund: { findMany: jest.fn() },
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
    const paid = (amount: string, status: OrderStatus | null, currency = Currency.UAH) => ({
      amount: d(amount),
      currency,
      order: status ? { status } : null,
    });
    prisma.payment.findMany.mockResolvedValue([
      paid('3614.32', OrderStatus.PAID),
      paid('2544.09', OrderStatus.PAID),
      paid('1000', OrderStatus.PARTIALLY_PAID),
      paid('50', OrderStatus.OVERPAID),
      paid('2500', null),
    ]);
    prisma.refund.findMany.mockResolvedValue([
      { amount: d('50'), order: { currency: Currency.UAH } },
    ]);

    const report = await service.build(dayStart);

    expect(prisma.payment.findMany).toHaveBeenCalledWith({
      where: { paidAt: { gte: dayStart, lt: new Date('2026-09-03T21:00:00Z') } },
      select: { amount: true, currency: true, order: { select: { status: true } } },
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

  it('should keep dollars out of the hryvnia totals and report them on their own', async () => {
    const paid = (amount: string, currency: Currency) => ({
      amount: d(amount),
      currency,
      order: { status: OrderStatus.PAID },
    });
    prisma.payment.findMany.mockResolvedValue([
      paid('1000', Currency.UAH),
      paid('150', Currency.USD),
      paid('50.50', Currency.USD),
    ]);
    prisma.refund.findMany.mockResolvedValue([
      { amount: d('20'), order: { currency: Currency.UAH } },
      { amount: d('5'), order: { currency: Currency.USD } },
    ]);

    const report = await service.build(dayStart);

    expect(report.paymentsCount).toBe(3);
    expect(report.totalAmount.toFixed(2)).toBe('1000.00');
    expect(report.refundsCount).toBe(1);
    expect(report.refundsAmount.toFixed(2)).toBe('20.00');
    expect(report.usd.paymentsAmount.toFixed(2)).toBe('200.50');
    expect(report.usd.refundsCount).toBe(1);
    expect(report.usd.refundsAmount.toFixed(2)).toBe('5.00');
  });

  it('should report an empty day', async () => {
    prisma.payment.findMany.mockResolvedValue([]);
    prisma.refund.findMany.mockResolvedValue([]);

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
