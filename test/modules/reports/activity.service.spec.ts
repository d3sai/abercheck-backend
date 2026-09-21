import { Test } from '@nestjs/testing';
import { OrderStatus, Prisma } from '../../../src/generated/prisma/client';
import { PrismaService } from '../../../src/common/prisma/prisma.service';
import { ActivityService } from '../../../src/modules/reports/activity.service';

const d = (value: string) => new Prisma.Decimal(value);
const at = (minute: number) => new Date(Date.UTC(2026, 8, 11, 12, minute));

describe('ActivityService', () => {
  const order = { findMany: jest.fn() };
  const payment = { findMany: jest.fn() };
  const refund = { findMany: jest.fn() };
  let service: ActivityService;

  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [
        ActivityService,
        { provide: PrismaService, useValue: { order, payment, refund } },
      ],
    }).compile();

    service = moduleRef.get(ActivityService);
    order.findMany.mockResolvedValue([
      {
        createdAt: at(1),
        orderNumber: '0000-066717',
        baseNumber: '0000-066717',
        amountDue: d('6158.41'),
        status: OrderStatus.PARTIALLY_PAID,
        clientName: 'Чернявський Владислав',
      },
    ]);
    payment.findMany.mockResolvedValue([
      { createdAt: at(3), amount: d('2544.09'), payerName: 'Сидоренко', order: null },
      {
        createdAt: at(2),
        amount: d('3614.32'),
        payerName: 'ФОП Гук В.С',
        order: { orderNumber: '0000-066717', status: OrderStatus.PARTIALLY_PAID },
      },
    ]);
    refund.findMany.mockResolvedValue([
      {
        createdAt: at(0),
        amount: d('50'),
        initiatedByName: 'Уляна',
        order: { orderNumber: '0000-066717', status: OrderStatus.PARTIALLY_PAID },
      },
    ]);
  });

  afterEach(() => jest.resetAllMocks());

  it('should merge orders, payments and refunds newest first up to the limit', async () => {
    const activity = await service.recent(3);

    expect(activity.map((item) => [item.kind, item.who])).toEqual([
      ['UNMATCHED_PAYMENT', 'Сидоренко'],
      ['PAYMENT', 'ФОП Гук В.С'],
      ['ORDER_CREATED', 'Чернявський Владислав'],
    ]);
    expect(activity[0]).toMatchObject({ orderNumber: null, status: null });
  });

  it('should show a manager only what happened to their orders', async () => {
    await service.recent(10, 7);

    expect(order.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { managerId: 7 }, take: 10 }),
    );
    expect(payment.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { order: { managerId: 7 } } }),
    );
    expect(refund.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { order: { managerId: 7 } } }),
    );
  });
});
