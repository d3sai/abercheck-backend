import { EventEmitter2 } from '@nestjs/event-emitter';
import { Test } from '@nestjs/testing';
import { Currency, MatchType, OrderStatus, Prisma } from '../../../src/generated/prisma/client';
import { PrismaService } from '../../../src/common/prisma/prisma.service';
import type { CreatePaymentDto } from '../../../src/modules/payments/dto/create-payment.dto';
import {
  OrderCancelledError,
  OrderCurrencyMismatchError,
  OrderNotFoundError,
} from '../../../src/modules/orders/orders.errors';
import { PaymentEvents } from '../../../src/modules/payments/payment-ingestion.types';
import {
  PaymentAlreadyAttachedError,
  PaymentNotFoundError,
} from '../../../src/modules/payments/payments.errors';
import { PaymentsService } from '../../../src/modules/payments/payments.service';

describe('PaymentsService', () => {
  const dto: CreatePaymentDto = {
    external_transaction_id: 'tx-1',
    order_number: '№А 0000-066717',
    amount: '3614.32',
    payer_name: 'Чернявський Владислав',
    receiving_account: 'ФОП Гук В.С',
    purpose_text: 'Оплата за замовлення',
    paid_at: '2026-09-03T15:00:00+03:00',
  };
  const order = {
    id: 10,
    orderNumber: '0000-066717',
    baseNumber: '0000-066717',
    clientName: 'Чернявський Владислав',
    amountDue: new Prisma.Decimal('6158.41'),
    currency: Currency.UAH as Currency,
    status: OrderStatus.AWAITING_PAYMENT,
  };

  type Part = Omit<typeof order, 'status'> & { status: OrderStatus };

  const tx = {
    $queryRaw: jest.fn(),
    order: { findUnique: jest.fn(), findMany: jest.fn(), update: jest.fn() },
    payment: { create: jest.fn(), aggregate: jest.fn(), findUnique: jest.fn(), update: jest.fn() },
    refund: { aggregate: jest.fn() },
  };
  const prisma = {
    payment: { findUnique: jest.fn() },
    $transaction: jest.fn<Promise<unknown>, [(client: typeof tx) => Promise<unknown>]>((callback) =>
      callback(tx),
    ),
  };
  const events = { emit: jest.fn() };
  let service: PaymentsService;
  let parts: Part[] = [];

  const withParts = (list: Part[]) => {
    parts = list;
    tx.order.findMany.mockResolvedValue(list);
  };

  const paidSoFar = (amount: string) =>
    tx.payment.aggregate.mockResolvedValue({ _sum: { amount: new Prisma.Decimal(amount) } });

  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [
        PaymentsService,
        { provide: PrismaService, useValue: prisma },
        { provide: EventEmitter2, useValue: events },
      ],
    }).compile();

    service = moduleRef.get(PaymentsService);
    prisma.payment.findUnique.mockResolvedValue(null);
    tx.$queryRaw.mockResolvedValue([{ id: order.id }]);
    withParts([order]);
    tx.order.findUnique.mockResolvedValue(null);
    tx.payment.create.mockImplementation(({ data }: { data: object }) => ({ id: 1, ...data }));
    tx.order.update.mockImplementation(
      ({ where, data }: { where: { id: number }; data: object }) => ({
        ...(parts.find((part) => part.id === where.id) ?? order),
        ...data,
      }),
    );
    tx.refund.aggregate.mockResolvedValue({ _sum: { amount: null } });
  });

  afterEach(() => jest.clearAllMocks());

  it('should record a partial payment against the normalized order number', async () => {
    paidSoFar('3614.32');

    const result = await service.ingest(dto);

    expect(result).toMatchObject({
      kind: 'recorded',
      previousStatus: OrderStatus.AWAITING_PAYMENT,
      order: { status: OrderStatus.PARTIALLY_PAID },
    });
    expect(tx.$queryRaw.mock.calls[0]).toContain('0000-066717');
    expect(tx.payment.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        orderId: order.id,
        reportedOrderNumber: '№А 0000-066717',
        matchType: MatchType.MATCHED_BY_PROVIDER,
        paidAt: new Date('2026-09-03T12:00:00Z'),
      }) as unknown,
    });
    expect(events.emit).toHaveBeenCalledWith(PaymentEvents.Recorded, result);
  });

  it('should mark the order paid when the second transfer covers the rest', async () => {
    withParts([{ ...order, status: OrderStatus.PARTIALLY_PAID }]);
    paidSoFar('6158.41');

    const result = await service.ingest({ ...dto, external_transaction_id: 'tx-2' });

    expect(result).toMatchObject({ kind: 'recorded', order: { status: OrderStatus.PAID } });
  });

  it('should record the currency of the payment, hryvnias by default', async () => {
    paidSoFar('3614.32');

    await service.ingest(dto);

    expect(tx.payment.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ currency: Currency.UAH }) as unknown,
    });
  });

  it('should apply a dollar payment to a dollar order', async () => {
    withParts([{ ...order, currency: Currency.USD }]);
    paidSoFar('150');

    const result = await service.ingest({ ...dto, amount: '150', currency: Currency.USD });

    expect(result).toMatchObject({ kind: 'recorded', payment: { currency: Currency.USD } });
  });

  it('should leave a dollar payment for a hryvnia order unmatched instead of mixing them', async () => {
    const result = await service.ingest({ ...dto, amount: '150', currency: Currency.USD });

    expect(result).toMatchObject({
      kind: 'unmatched',
      payment: {
        orderId: null,
        currency: Currency.USD,
        reportedOrderNumber: '№А 0000-066717',
        matchType: MatchType.MANUAL,
      },
    });
    expect(tx.order.update).not.toHaveBeenCalled();
    expect(events.emit).toHaveBeenCalledWith(PaymentEvents.Unmatched, result);
  });

  it('should not rewrite the order when its status stays the same', async () => {
    withParts([{ ...order, status: OrderStatus.PARTIALLY_PAID }]);
    paidSoFar('5000');

    await service.ingest(dto);

    expect(tx.order.update).not.toHaveBeenCalled();
  });

  it('should keep a payment for an unknown order for manual review', async () => {
    withParts([]);

    const result = await service.ingest(dto);

    expect(result.kind).toBe('unmatched');
    expect(tx.payment.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ orderId: null, matchType: MatchType.MANUAL }) as unknown,
    });
    expect(tx.payment.aggregate).not.toHaveBeenCalled();
    expect(events.emit).toHaveBeenCalledWith(PaymentEvents.Unmatched, result);
  });

  it('should not look up an order when the provider sent no order number', async () => {
    const result = await service.ingest({ ...dto, order_number: null });

    expect(result.kind).toBe('unmatched');
    expect(tx.order.findMany).not.toHaveBeenCalled();
  });

  it('should return an already processed transaction without side effects', async () => {
    prisma.payment.findUnique.mockResolvedValue({ id: 1 });

    const result = await service.ingest(dto);

    expect(result).toEqual({ kind: 'duplicate', payment: { id: 1 } });
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(events.emit).not.toHaveBeenCalled();
  });

  it('should treat a concurrent insert of the same transaction as a duplicate', async () => {
    prisma.payment.findUnique.mockResolvedValueOnce(null).mockResolvedValueOnce({ id: 1 });
    prisma.$transaction.mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError('unique', { code: 'P2002', clientVersion: 'test' }),
    );

    await expect(service.ingest(dto)).resolves.toEqual({ kind: 'duplicate', payment: { id: 1 } });
    expect(events.emit).not.toHaveBeenCalled();
  });

  it('should rethrow unexpected database errors', async () => {
    const error = new Error('connection lost');
    prisma.$transaction.mockRejectedValueOnce(error);

    await expect(service.ingest(dto)).rejects.toBe(error);
  });

  it('should count paid money net of refunds', async () => {
    withParts([{ ...order, status: OrderStatus.OVERPAID }]);
    paidSoFar('6208.41');
    tx.refund.aggregate.mockResolvedValue({ _sum: { amount: new Prisma.Decimal('50') } });

    const result = await service.ingest(dto);

    expect(result).toMatchObject({ kind: 'recorded', order: { status: OrderStatus.PAID } });
  });

  describe('a number with several orders', () => {
    const second = {
      ...order,
      id: 11,
      orderNumber: '0000-066717(1)',
      clientName: 'Другий ФОП',
      amountDue: new Prisma.Decimal('1000'),
    };

    it('should cover every part with one payment and report the number as a whole', async () => {
      withParts([order, second]);
      paidSoFar('7158.41');

      const result = await service.ingest(dto);

      expect(result).toMatchObject({
        kind: 'recorded',
        previousStatus: OrderStatus.AWAITING_PAYMENT,
        amountPaid: new Prisma.Decimal('7158.41'),
        order: {
          orderNumber: '0000-066717',
          amountDue: new Prisma.Decimal('7158.41'),
          clientName: 'Чернявський Владислав, Другий ФОП',
          status: OrderStatus.PAID,
        },
      });
      expect(tx.order.update).toHaveBeenCalledTimes(2);
      expect(tx.order.update).toHaveBeenCalledWith({
        where: { id: 11 },
        data: { status: OrderStatus.PAID },
      });
    });

    it('should leave the whole number partially paid until the total is covered', async () => {
      withParts([order, second]);
      paidSoFar('6158.41');

      const result = await service.ingest(dto);

      expect(result).toMatchObject({ order: { status: OrderStatus.PARTIALLY_PAID } });
    });

    it('should hang the payment on the first part that is still alive', async () => {
      withParts([{ ...order, status: OrderStatus.CANCELLED }, second]);
      paidSoFar('1000');

      await service.ingest(dto);

      expect(tx.payment.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ orderId: 11 }) as unknown,
      });
    });

    it('should not count a cancelled part towards what is due', async () => {
      withParts([{ ...order, status: OrderStatus.CANCELLED }, second]);
      paidSoFar('1000');

      const result = await service.ingest(dto);

      expect(result).toMatchObject({ order: { status: OrderStatus.PAID } });
    });

    it('should find the group through any of its different numbers', async () => {
      tx.order.findUnique.mockResolvedValue({ baseNumber: '0000-000001' });
      withParts([order, second]);
      paidSoFar('7158.41');

      const result = await service.ingest({ ...dto, order_number: '0000-000005' });

      expect(tx.order.findUnique).toHaveBeenCalledWith({
        where: { orderNumber: '0000-000005' },
        select: { baseNumber: true },
      });
      expect(tx.$queryRaw.mock.calls[0]).toContain('0000-000001');
      expect(result).toMatchObject({ kind: 'recorded', order: { status: OrderStatus.PAID } });
    });

    it('should attach a manual payment through any number of the group as well', async () => {
      tx.payment.findUnique.mockResolvedValue({ id: 15, orderId: null, currency: Currency.UAH });
      tx.payment.update.mockImplementation(({ data }: { data: object }) => ({ id: 15, ...data }));
      tx.order.findUnique.mockResolvedValue({ baseNumber: '0000-000001' });
      withParts([order, second]);
      paidSoFar('7158.41');

      await service.attach(15, '0000-000005');

      expect(tx.$queryRaw.mock.calls[1]).toContain('0000-000001');
    });

    it('should resolve a suffixed number to the group', async () => {
      withParts([order, second]);
      paidSoFar('100');

      await service.ingest({ ...dto, order_number: '0000-066717(1)' });

      expect(tx.$queryRaw.mock.calls[0]).toContain('0000-066717');
    });
  });

  describe('attach', () => {
    const unmatched = {
      id: 15,
      orderId: null,
      amount: new Prisma.Decimal('2544.09'),
      currency: Currency.UAH,
    };

    beforeEach(() => {
      tx.payment.findUnique.mockResolvedValue(unmatched);
      tx.payment.update.mockImplementation(({ data }: { data: object }) => ({
        ...unmatched,
        ...data,
      }));
    });

    it('should attach an unknown payment and recalculate the order', async () => {
      paidSoFar('2544.09');

      const result = await service.attach(15, '№Т 0000-066717');

      expect(tx.payment.update).toHaveBeenCalledWith({
        where: { id: 15 },
        data: { orderId: order.id },
      });
      expect(result).toMatchObject({
        kind: 'recorded',
        order: { status: OrderStatus.PARTIALLY_PAID },
      });
      expect(events.emit).toHaveBeenCalledWith(PaymentEvents.Recorded, result);
    });

    it('should refuse to attach a payment to an order in another currency', async () => {
      tx.payment.findUnique.mockResolvedValue({ ...unmatched, currency: Currency.USD });

      await expect(service.attach(15, '0000-066717')).rejects.toBeInstanceOf(
        OrderCurrencyMismatchError,
      );
      expect(tx.payment.update).not.toHaveBeenCalled();
      expect(events.emit).not.toHaveBeenCalled();
    });

    it('should refuse a payment that is already attached', async () => {
      tx.payment.findUnique.mockResolvedValue({ ...unmatched, orderId: 3 });

      await expect(service.attach(15, '0000-066717')).rejects.toBeInstanceOf(
        PaymentAlreadyAttachedError,
      );
      expect(events.emit).not.toHaveBeenCalled();
    });

    it('should refuse an unknown payment id', async () => {
      tx.$queryRaw.mockResolvedValueOnce([]);

      await expect(service.attach(99, '0000-066717')).rejects.toBeInstanceOf(PaymentNotFoundError);
    });

    it('should refuse an order that does not exist or is cancelled', async () => {
      withParts([]);
      await expect(service.attach(15, '0000-000000')).rejects.toBeInstanceOf(OrderNotFoundError);

      withParts([{ ...order, status: OrderStatus.CANCELLED }]);
      await expect(service.attach(15, '0000-066717')).rejects.toBeInstanceOf(OrderCancelledError);
      expect(tx.payment.update).not.toHaveBeenCalled();
    });

    it('should attach to the number of a suffixed part and refuse a number whose parts are all cancelled', async () => {
      paidSoFar('2544.09');
      await service.attach(15, '0000-066717(1)');
      expect(tx.$queryRaw.mock.calls[1]).toContain('0000-066717');

      withParts([
        { ...order, status: OrderStatus.CANCELLED },
        { ...order, id: 11, orderNumber: '0000-066717(1)', status: OrderStatus.CANCELLED },
      ]);
      await expect(service.attach(15, '0000-066717')).rejects.toBeInstanceOf(OrderCancelledError);
    });
  });
});
