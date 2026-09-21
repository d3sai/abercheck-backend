import { EventEmitter2 } from '@nestjs/event-emitter';
import { Test } from '@nestjs/testing';
import { OrderStatus, Prisma } from '../../../src/generated/prisma/client';
import { PrismaService } from '../../../src/common/prisma/prisma.service';
import type { CreateOrderDto } from '../../../src/modules/orders/dto/create-order.dto';
import { OrderEvents } from '../../../src/modules/orders/order.events';
import {
  OrderNotFoundError,
  OrderNumberTakenError,
} from '../../../src/modules/orders/orders.errors';
import { OrdersService } from '../../../src/modules/orders/orders.service';

const d = (value: string) => new Prisma.Decimal(value);

const prismaError = (code: string) =>
  new Prisma.PrismaClientKnownRequestError('prisma error', { code, clientVersion: 'test' });

const part = (
  id: number,
  orderNumber: string,
  amountDue: string,
  status: OrderStatus = OrderStatus.PAID,
  baseNumber = orderNumber.replace(/\(\d+\)$/, ''),
) => ({
  id,
  orderNumber,
  baseNumber,
  clientName: `ФОП ${id}`,
  amountDue: d(amountDue),
  status,
  manager: { id: 7, name: 'Олена' },
});

describe('OrdersService', () => {
  const order = {
    findUnique: jest.fn(),
    findMany: jest.fn(),
    groupBy: jest.fn(),
    count: jest.fn(),
    update: jest.fn(),
  };
  const payment = { groupBy: jest.fn(), findMany: jest.fn() };
  const refund = { groupBy: jest.fn(), findMany: jest.fn() };
  const tx = {
    $queryRaw: jest.fn(),
    order: { findUnique: jest.fn(), findMany: jest.fn(), create: jest.fn(), update: jest.fn() },
    payment: { aggregate: jest.fn() },
    refund: { aggregate: jest.fn() },
    orderAmountChange: { create: jest.fn() },
  };
  const $transaction = jest.fn<Promise<unknown>, [(client: typeof tx) => Promise<unknown>]>();
  const events = { emit: jest.fn() };
  let service: OrdersService;

  const admin = { telegramId: 111n, name: 'Уляна' };

  const dto: CreateOrderDto = {
    orderNumber: 'ЗН-000123',
    clientName: 'Іваненко Іван',
    amountDue: '1250.50',
  };

  const paidSoFar = (amount: string | null) => {
    tx.payment.aggregate.mockResolvedValue({ _sum: { amount: amount ? d(amount) : null } });
    tx.refund.aggregate.mockResolvedValue({ _sum: { amount: null } });
  };

  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [
        OrdersService,
        { provide: PrismaService, useValue: { order, payment, refund, $transaction } },
        { provide: EventEmitter2, useValue: events },
      ],
    }).compile();

    service = moduleRef.get(OrdersService);
    payment.groupBy.mockResolvedValue([]);
    refund.groupBy.mockResolvedValue([]);
    $transaction.mockImplementation((callback) => callback(tx));
    tx.$queryRaw.mockResolvedValue([{ id: 1 }]);
    tx.order.findMany.mockResolvedValue([]);
    tx.order.create.mockImplementation(({ data }: { data: object }) => ({
      id: 1,
      status: OrderStatus.AWAITING_PAYMENT,
      ...data,
    }));
    tx.order.update.mockImplementation(
      ({ where, data }: { where: { id: number }; data: object }) => ({
        id: where.id,
        ...data,
      }),
    );
    tx.orderAmountChange.create.mockImplementation(({ data }: { data: object }) => ({
      id: 1,
      ...data,
    }));
    paidSoFar(null);
  });

  afterEach(() => jest.resetAllMocks());

  describe('create', () => {
    it('should attach the order to the manager who created it', async () => {
      await service.create(7, dto);

      expect(tx.order.create).toHaveBeenCalledWith({
        data: { ...dto, orderNumber: 'ЗН-000123', baseNumber: 'ЗН-000123', managerId: 7 },
      });
    });

    it('should emit an event once the order is created', async () => {
      await service.create(7, dto);

      expect(events.emit).toHaveBeenCalledWith(OrderEvents.Created, {
        order: expect.objectContaining({ orderNumber: 'ЗН-000123' }) as unknown,
      });
    });

    it('should stay silent when the caller asked not to notify', async () => {
      await service.create(7, dto, { notify: false });

      expect(events.emit).not.toHaveBeenCalled();
    });

    it('should not emit an event when creation fails', async () => {
      tx.order.create.mockRejectedValue(prismaError('P2002'));

      await expect(service.create(7, dto)).rejects.toBeInstanceOf(OrderNumberTakenError);
      expect(events.emit).not.toHaveBeenCalled();
    });

    it('should store the order number in the canonical 1C format', async () => {
      await service.create(7, { ...dto, orderNumber: '№А 0000-066717' });

      expect(tx.order.create).toHaveBeenCalledWith({
        data: { ...dto, orderNumber: '0000-066717', baseNumber: '0000-066717', managerId: 7 },
      });
    });

    it('should rethrow unexpected database errors', async () => {
      const error = prismaError('P1001');
      tx.order.create.mockRejectedValue(error);

      await expect(service.create(7, dto)).rejects.toBe(error);
    });

    it('should generate a number for a closing minus, which is a group of its own', async () => {
      await service.create(7, { clientName: 'Мінус', amountDue: '80' });

      expect(tx.order.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          orderNumber: expect.stringMatching(/^МІНУС-\d+$/) as unknown,
          baseNumber: expect.stringMatching(/^МІНУС-\d+$/) as unknown,
        }) as unknown,
      });
      const [[{ data }]] = tx.order.create.mock.calls as unknown as [
        [{ data: { orderNumber: string; baseNumber: string } }],
      ];
      expect(data.baseNumber).toBe(data.orderNumber);
    });

    describe('on a number that is already taken', () => {
      const existing = [part(1, '0000-066717', '1000')];

      it('should refuse it by default and name the whole number', async () => {
        tx.order.findMany.mockResolvedValue(existing);

        await expect(service.create(7, { ...dto, orderNumber: '0000-066717' })).rejects.toEqual(
          expect.objectContaining({ orderNumber: '0000-066717' }),
        );
        expect(tx.order.create).not.toHaveBeenCalled();
        expect(events.emit).not.toHaveBeenCalled();
      });

      it('should add the next part with a (n) suffix when asked to', async () => {
        tx.order.findMany.mockResolvedValue([...existing, part(2, '0000-066717(1)', '500')]);

        await service.create(7, { ...dto, orderNumber: '0000-066717' }, { addPart: true });

        expect(tx.order.create).toHaveBeenCalledWith({
          data: {
            ...dto,
            orderNumber: '0000-066717(2)',
            baseNumber: '0000-066717',
            managerId: 7,
          },
        });
      });

      it('should number the first extra part (1)', async () => {
        tx.order.findMany.mockResolvedValue(existing);

        await service.create(7, { ...dto, orderNumber: '0000-066717' }, { addPart: true });

        expect(tx.order.create).toHaveBeenCalledWith({
          data: expect.objectContaining({ orderNumber: '0000-066717(1)' }) as unknown,
        });
      });

      it('should treat a typed suffix as the same number', async () => {
        tx.order.findMany.mockResolvedValue(existing);

        await service.create(7, { ...dto, orderNumber: '0000-066717(5)' }, { addPart: true });

        expect(tx.$queryRaw.mock.calls[0]).toContain('0000-066717');
        expect(tx.order.create).toHaveBeenCalledWith({
          data: expect.objectContaining({
            orderNumber: '0000-066717(1)',
            baseNumber: '0000-066717',
          }) as unknown,
        });
      });

      it('should reopen a paid number, so the new part shares its status', async () => {
        tx.order.findMany.mockResolvedValue(existing);
        paidSoFar('1000');

        const created = await service.create(
          7,
          { ...dto, orderNumber: '0000-066717' },
          { addPart: true },
        );

        expect(tx.order.update).toHaveBeenCalledWith({
          where: { id: 1 },
          data: { status: OrderStatus.PARTIALLY_PAID },
        });
        expect(created.status).toBe(OrderStatus.PARTIALLY_PAID);
        expect(events.emit).toHaveBeenCalledWith(OrderEvents.Created, { order: created });
      });
    });
  });

  describe('createGroup', () => {
    const items = [
      { orderNumber: '0000-068772', amountDue: '335.58' },
      { orderNumber: '№ 0000-068773', amountDue: '971.83' },
      { orderNumber: '0000-068774', amountDue: '605.41' },
    ];
    const common = {
      clientName: 'Гук Віктор Степанович ФОП',
      exchangeRate: '44.9',
      comment: 'весь текст',
      requisites: 'реквізити',
    };

    it('should create each number as its own order under the first number', async () => {
      const created = await service.createGroup(7, items, common);

      expect(created).toHaveLength(3);
      expect(tx.order.create).toHaveBeenNthCalledWith(1, {
        data: {
          orderType: 'REQUISITES',
          orderNumber: '0000-068772',
          baseNumber: '0000-068772',
          clientName: 'Гук Віктор Степанович ФОП',
          amountDue: '335.58',
          exchangeRate: '44.9',
          comment: 'весь текст',
          requisites: 'реквізити',
          managerId: 7,
        },
      });
      expect(tx.order.create).toHaveBeenNthCalledWith(2, {
        data: expect.objectContaining({
          orderNumber: '0000-068773',
          baseNumber: '0000-068772',
          amountDue: '971.83',
          comment: 'Оплата разом із № 0000-068772',
          requisites: undefined,
        }) as unknown,
      });
      expect(tx.order.create).toHaveBeenNthCalledWith(3, {
        data: expect.objectContaining({
          orderNumber: '0000-068774',
          baseNumber: '0000-068772',
        }) as unknown,
      });
    });

    it('should create nothing when one of the numbers is already taken', async () => {
      tx.order.findMany.mockResolvedValue([{ orderNumber: '0000-068773' }]);

      await expect(service.createGroup(7, items, common)).rejects.toEqual(
        expect.objectContaining({ orderNumber: '0000-068773' }),
      );
      expect(tx.order.create).not.toHaveBeenCalled();
    });

    it('should look for numbers that are taken as a number or as a group', async () => {
      await service.createGroup(7, items, common);

      expect(tx.order.findMany).toHaveBeenCalledWith({
        where: {
          OR: [
            { orderNumber: { in: ['0000-068772', '0000-068773', '0000-068774'] } },
            { baseNumber: { in: ['0000-068772', '0000-068773', '0000-068774'] } },
          ],
        },
        select: { orderNumber: true },
      });
    });

    it('should refuse the same number listed twice', async () => {
      await expect(
        service.createGroup(7, [items[0]!, { ...items[0]! }], common),
      ).rejects.toBeInstanceOf(OrderNumberTakenError);
      expect(tx.order.create).not.toHaveBeenCalled();
    });

    it('should turn a race on a unique number into OrderNumberTakenError', async () => {
      tx.order.create.mockRejectedValue(prismaError('P2002'));

      await expect(service.createGroup(7, items, common)).rejects.toBeInstanceOf(
        OrderNumberTakenError,
      );
    });

    it('should stay silent unless asked, and then announce every order', async () => {
      await service.createGroup(7, items, common);
      expect(events.emit).not.toHaveBeenCalled();

      await service.createGroup(7, items, common, { notify: true });
      expect(events.emit).toHaveBeenCalledTimes(3);
    });
  });

  describe('list', () => {
    it('should filter by manager and statuses, newest first, with the total count', async () => {
      order.findMany.mockResolvedValue([]);
      order.count.mockResolvedValue(42);

      const result = await service.list(
        { managerId: 7, statuses: [OrderStatus.AWAITING_PAYMENT, OrderStatus.PARTIALLY_PAID] },
        25,
      );

      const where = { managerId: 7, status: { in: ['AWAITING_PAYMENT', 'PARTIALLY_PAID'] } };
      expect(order.findMany).toHaveBeenCalledWith({
        where,
        include: { manager: true },
        orderBy: { createdAt: 'desc' },
        take: 25,
      });
      expect(order.count).toHaveBeenCalledWith({ where });
      expect(result).toEqual({ items: [], total: 42 });
    });

    it('should show each order its own share of what was paid against the number', async () => {
      const first = part(1, '0000-066717', '700');
      const second = part(2, '0000-066717(1)', '300');
      order.findMany.mockResolvedValueOnce([second, first]).mockResolvedValueOnce([first, second]);
      order.count.mockResolvedValue(2);
      payment.groupBy.mockResolvedValue([{ orderId: 1, _sum: { amount: d('800') } }]);

      const { items } = await service.list({}, 25);

      expect(items.map((item) => [item.order.orderNumber, item.amountPaid.toFixed(2)])).toEqual([
        ['0000-066717(1)', '100.00'],
        ['0000-066717', '700.00'],
      ]);
    });
  });

  describe('findWithBalance', () => {
    it('should look up the whole number by its base and subtract refunds', async () => {
      order.findMany.mockResolvedValue([part(1, '0000-066717', '6158.41')]);
      payment.groupBy.mockResolvedValue([{ orderId: 1, _sum: { amount: d('6208.41') } }]);
      refund.groupBy.mockResolvedValue([{ orderId: 1, _sum: { amount: d('50') } }]);

      const result = await service.findWithBalance('№Р 0000-066717(1)');

      expect(order.findMany).toHaveBeenCalledWith({
        where: { baseNumber: { in: ['0000-066717'] } },
        include: { manager: true },
        orderBy: { id: 'asc' },
      });
      expect(result?.amountPaid.toFixed(2)).toBe('6158.41');
    });

    it('should find the group through any of its different numbers and list them all', async () => {
      order.findUnique.mockResolvedValue({ baseNumber: '0000-000001' });
      order.findMany.mockResolvedValue([
        part(1, '0000-000001', '10'),
        part(2, '0000-000005', '20', OrderStatus.PAID, '0000-000001'),
        part(3, '0000-000009', '30', OrderStatus.CANCELLED, '0000-000001'),
      ]);

      const result = await service.findWithBalance('0000-000005');

      expect(order.findUnique).toHaveBeenCalledWith({
        where: { orderNumber: '0000-000005' },
        select: { baseNumber: true },
      });
      expect(order.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { baseNumber: { in: ['0000-000001'] } } }),
      );
      expect(result?.order).toMatchObject({ orderNumber: '0000-000001', amountDue: d('30') });
      expect(result?.orderNumbers).toEqual(['0000-000001', '0000-000005']);
    });

    it('should describe a number with several orders as one order for the total', async () => {
      order.findMany.mockResolvedValue([
        part(1, '0000-066717', '3000'),
        part(2, '0000-066717(1)', '1000'),
      ]);
      payment.groupBy.mockResolvedValue([{ orderId: 1, _sum: { amount: d('1500') } }]);

      const result = await service.findWithBalance('0000-066717');

      expect(result?.order).toMatchObject({
        orderNumber: '0000-066717',
        clientName: 'ФОП 1, ФОП 2',
        amountDue: d('4000'),
      });
      expect(result?.amountPaid.toFixed(2)).toBe('1500.00');
    });

    it('should ignore cancelled parts when totalling what is due', async () => {
      order.findMany.mockResolvedValue([
        part(1, '0000-066717', '3000', OrderStatus.CANCELLED),
        part(2, '0000-066717(1)', '1000', OrderStatus.AWAITING_PAYMENT),
      ]);

      const result = await service.findWithBalance('0000-066717');

      expect(result?.order.amountDue.toFixed(2)).toBe('1000.00');
      expect(result?.order.status).toBe(OrderStatus.AWAITING_PAYMENT);
    });

    it('should return null for an unknown order', async () => {
      order.findMany.mockResolvedValue([]);

      await expect(service.findWithBalance('0000-000000')).resolves.toBeNull();
    });
  });

  describe('findWithBalanceById', () => {
    it('should resolve the id to its whole number', async () => {
      order.findUnique.mockResolvedValue({ baseNumber: '0000-066717' });
      order.findMany.mockResolvedValue([
        part(1, '0000-066717', '10'),
        part(2, '0000-066717(1)', '20'),
      ]);

      const result = await service.findWithBalanceById(2);

      expect(order.findUnique).toHaveBeenCalledWith({
        where: { id: 2 },
        select: { baseNumber: true },
      });
      expect(result?.order.amountDue.toFixed(2)).toBe('30.00');
    });

    it('should return null for an unknown id', async () => {
      order.findUnique.mockResolvedValue(null);

      await expect(service.findWithBalanceById(404)).resolves.toBeNull();
    });
  });

  describe('findGroupsByOrderIds', () => {
    it('should return each number once, however many of its orders were given', async () => {
      order.findMany
        .mockResolvedValueOnce([
          { baseNumber: 'A-1' },
          { baseNumber: 'A-1' },
          { baseNumber: 'B-2' },
        ])
        .mockResolvedValueOnce([part(1, 'A-1', '10'), part(2, 'A-1(1)', '5'), part(3, 'B-2', '7')]);

      const groups = await service.findGroupsByOrderIds([1, 2, 3]);

      expect(groups.map((g) => [g.order.orderNumber, g.order.amountDue.toFixed(2)])).toEqual([
        ['A-1', '15.00'],
        ['B-2', '7.00'],
      ]);
    });

    it('should not query anything for an empty list', async () => {
      await expect(service.findGroupsByOrderIds([])).resolves.toEqual([]);
      expect(order.findMany).not.toHaveBeenCalled();
    });
  });

  describe('findUnpaid', () => {
    const unpaidWhere = { status: { in: ['AWAITING_PAYMENT', 'PARTIALLY_PAID', 'UNDERPAID'] } };

    it('should list a number once, with the total of its parts and what was paid', async () => {
      order.groupBy.mockResolvedValue([{ baseNumber: '0000-066717', _min: { id: 1 } }]);
      order.findMany.mockResolvedValue([
        part(1, '0000-066717', '3000', OrderStatus.PARTIALLY_PAID),
        part(2, '0000-066717(1)', '1000', OrderStatus.PARTIALLY_PAID),
      ]);
      payment.groupBy.mockResolvedValue([{ orderId: 1, _sum: { amount: d('3614.32') } }]);

      const result = await service.findUnpaid(50);

      expect(order.groupBy).toHaveBeenCalledWith({
        by: ['baseNumber'],
        where: unpaidWhere,
        _min: { id: true },
        having: undefined,
        orderBy: { _min: { id: 'asc' } },
        take: 51,
      });
      expect(result.items).toHaveLength(1);
      expect(result.items[0]!.order).toMatchObject({
        orderNumber: '0000-066717',
        amountDue: d('4000'),
      });
      expect(result.items[0]!.amountPaid.toFixed(2)).toBe('3614.32');
      expect(result.items[0]!.orderNumbers).toEqual(['0000-066717', '0000-066717(1)']);
      expect(result.nextCursor).toBeNull();
    });

    it('should skip loading orders and payments when nothing is unpaid', async () => {
      order.groupBy.mockResolvedValue([]);

      await expect(service.findUnpaid(50)).resolves.toEqual({ items: [], nextCursor: null });
      expect(order.findMany).not.toHaveBeenCalled();
      expect(payment.groupBy).not.toHaveBeenCalled();
    });

    it('should return a cursor and drop the lookahead number when there are more pages', async () => {
      order.groupBy.mockResolvedValue([
        { baseNumber: 'A-1', _min: { id: 1 } },
        { baseNumber: 'B-2', _min: { id: 4 } },
        { baseNumber: 'C-3', _min: { id: 9 } },
      ]);
      order.findMany.mockResolvedValue([part(1, 'A-1', '1'), part(4, 'B-2', '1')]);

      const result = await service.findUnpaid(2);

      expect(order.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { baseNumber: { in: ['A-1', 'B-2'] } } }),
      );
      expect(result.items.map((item) => item.order.orderNumber)).toEqual(['A-1', 'B-2']);
      expect(result.nextCursor).toBe(4);
    });

    it('should resume after the given cursor', async () => {
      order.groupBy.mockResolvedValue([]);

      await service.findUnpaid(50, 7);

      expect(order.groupBy).toHaveBeenCalledWith(
        expect.objectContaining({ having: { id: { _min: { gt: 7 } } }, take: 51 }),
      );
    });
  });

  describe('update', () => {
    it('should throw OrderNotFoundError when the order does not exist', async () => {
      order.update.mockRejectedValue(prismaError('P2025'));

      await expect(service.update('404', { comment: 'x' }, admin)).rejects.toBeInstanceOf(
        OrderNotFoundError,
      );
    });

    it('should update fields directly without a transaction when amountDue is unchanged', async () => {
      order.update.mockResolvedValue({ id: 1, comment: 'x' });

      await service.update('0000-066717', { comment: 'x' }, admin);

      expect(order.update).toHaveBeenCalledWith({
        where: { orderNumber: '0000-066717' },
        data: { comment: 'x' },
      });
      expect($transaction).not.toHaveBeenCalled();
    });

    it('should persist the new amount, record the audit trail and recalculate the status', async () => {
      const only = part(1, '0000-066717', '100');
      tx.order.findUnique.mockResolvedValue(only);
      tx.order.findMany.mockResolvedValue([only]);
      paidSoFar('100');

      await service.update('0000-066717', { amountDue: '150' }, admin);

      expect(tx.orderAmountChange.create).toHaveBeenCalledWith({
        data: {
          orderId: 1,
          previousAmountDue: d('100'),
          newAmountDue: d('150'),
          changedByTelegramId: admin.telegramId,
          changedByName: admin.name,
        },
      });
      expect(tx.order.update).toHaveBeenNthCalledWith(1, {
        where: { id: 1 },
        data: { amountDue: d('150') },
      });
      expect(tx.order.update).toHaveBeenNthCalledWith(2, {
        where: { id: 1 },
        data: { status: OrderStatus.PARTIALLY_PAID },
      });
    });

    it('should re-evaluate every part of the number when one of them changes', async () => {
      const first = part(1, '0000-066717', '100');
      const second = part(2, '0000-066717(1)', '100');
      tx.order.findUnique.mockResolvedValue(second);
      tx.order.findMany.mockResolvedValue([first, second]);
      paidSoFar('200');

      await service.update('0000-066717(1)', { amountDue: '150' }, admin);

      expect(tx.orderAmountChange.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ orderId: 2 }) as unknown,
      });
      expect(tx.order.update).toHaveBeenCalledWith({
        where: { id: 1 },
        data: { status: OrderStatus.PARTIALLY_PAID },
      });
      expect(tx.order.update).toHaveBeenCalledWith({
        where: { id: 2 },
        data: { status: OrderStatus.PARTIALLY_PAID },
      });
    });

    it('should throw OrderNotFoundError when amending the amount of an unknown order', async () => {
      tx.$queryRaw.mockResolvedValue([]);
      tx.order.findUnique.mockResolvedValue(null);

      await expect(service.update('404', { amountDue: '150' }, admin)).rejects.toBeInstanceOf(
        OrderNotFoundError,
      );
      expect(tx.orderAmountChange.create).not.toHaveBeenCalled();
    });
  });

  describe('search', () => {
    beforeEach(() => {
      order.findMany.mockResolvedValue([]);
      order.count.mockResolvedValue(0);
    });

    it('should match number and client within the filters', async () => {
      await service.search({
        managerId: 7,
        statuses: [OrderStatus.PAID],
        text: '0667',
        sort: 'amountDue',
        direction: 'asc',
        skip: 25,
        take: 25,
      });

      const where = {
        managerId: 7,
        status: { in: ['PAID'] },
        OR: [
          { orderNumber: { contains: '0667', mode: 'insensitive' } },
          { clientName: { contains: '0667', mode: 'insensitive' } },
        ],
      };
      expect(order.findMany).toHaveBeenCalledWith({
        where,
        include: { manager: true },
        orderBy: [{ amountDue: 'asc' }, { id: 'asc' }],
        skip: 25,
        take: 25,
      });
      expect(order.count).toHaveBeenCalledWith({ where });
    });

    it('should not filter when no criteria are given', async () => {
      await service.search({ sort: 'createdAt', direction: 'desc', skip: 0, take: 25 });

      expect(order.count).toHaveBeenCalledWith({ where: {} });
    });

    it('should treat an empty status list as no status filter', async () => {
      await service.search({
        statuses: [],
        sort: 'createdAt',
        direction: 'desc',
        skip: 0,
        take: 25,
      });

      expect(order.count).toHaveBeenCalledWith({ where: {} });
    });
  });

  describe('findLedger', () => {
    const first = part(1, '0000-066717', '700');
    const second = part(2, '0000-066717(1)', '300');

    it("should return one order with the whole number's payments and refunds in time order", async () => {
      order.findUnique.mockResolvedValue({ baseNumber: '0000-066717' });
      order.findMany.mockResolvedValue([first, second]);
      payment.findMany.mockResolvedValue([{ id: 10 }]);
      refund.findMany.mockResolvedValue([{ id: 20 }]);
      payment.groupBy.mockResolvedValue([{ orderId: 1, _sum: { amount: d('800') } }]);

      const ledger = await service.findLedger('0000-066717(1)');

      expect(order.findUnique).toHaveBeenCalledWith({
        where: { orderNumber: '0000-066717(1)' },
        select: { baseNumber: true },
      });
      expect(payment.findMany).toHaveBeenCalledWith({
        where: { order: { baseNumber: '0000-066717' } },
        orderBy: [{ paidAt: 'asc' }, { id: 'asc' }],
      });
      expect(refund.findMany).toHaveBeenCalledWith({
        where: { order: { baseNumber: '0000-066717' } },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      });
      expect(ledger).toMatchObject({
        order: { id: 2, orderNumber: '0000-066717(1)' },
        payments: [{ id: 10 }],
        refunds: [{ id: 20 }],
        group: { baseNumber: '0000-066717', parts: [{ id: 1 }, { id: 2 }] },
      });
      expect(ledger?.amountPaid.toFixed(2)).toBe('100.00');
      expect(ledger?.group.amountPaid.toFixed(2)).toBe('800.00');
      expect(ledger?.group.amountDue.toFixed(2)).toBe('1000.00');
    });

    it('should normalize a number pasted with noise but keep its part suffix', async () => {
      order.findUnique.mockResolvedValue({ baseNumber: '0000-066717' });
      order.findMany.mockResolvedValue([first, second]);
      payment.findMany.mockResolvedValue([]);
      refund.findMany.mockResolvedValue([]);

      await service.findLedger('№А 0000-066717 (1)');

      expect(order.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({ where: { orderNumber: '0000-066717(1)' } }),
      );
    });

    it('should return null for an unknown order', async () => {
      order.findUnique.mockResolvedValue(null);

      await expect(service.findLedger('0000-000000')).resolves.toBeNull();
      expect(payment.findMany).not.toHaveBeenCalled();
    });
  });
});
