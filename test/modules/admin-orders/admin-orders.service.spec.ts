import { Logger } from '@nestjs/common';
import { Currency, OrderStatus, Prisma } from '../../../src/generated/prisma/client';
import { AdminOrdersService } from '../../../src/modules/admin-orders/admin-orders.service';

const d = (value: string) => new Prisma.Decimal(value);

const order = (id: number, orderNumber: string, status: OrderStatus = OrderStatus.PAID) => ({
  id,
  orderNumber,
  baseNumber: orderNumber.replace(/\(\d+\)$/, ''),
  clientName: `ФОП ${id}`,
  amountDue: d('100.00'),
  currency: Currency.UAH,
  status,
  createdAt: new Date('2026-10-01T10:00:00Z'),
});

const rejectsWith = async (promise: Promise<unknown>, code: string) =>
  expect(promise).rejects.toMatchObject({ response: { code } });

describe('AdminOrdersService', () => {
  const prisma = {
    order: { findUnique: jest.fn(), findMany: jest.fn() },
    $transaction: jest.fn(),
  };
  const tx = {
    $queryRaw: jest.fn(),
    order: { findUnique: jest.fn(), findMany: jest.fn(), delete: jest.fn(), update: jest.fn() },
    refund: { deleteMany: jest.fn(), aggregate: jest.fn() },
    payment: { deleteMany: jest.fn(), updateMany: jest.fn(), aggregate: jest.fn() },
    orderRequisite: { deleteMany: jest.fn() },
    orderAmountChange: { deleteMany: jest.fn() },
    orderAttachment: { findMany: jest.fn(), deleteMany: jest.fn() },
  };
  const attachments = { discardMessage: jest.fn() };
  let service: AdminOrdersService;
  let log: jest.SpyInstance;

  beforeEach(() => {
    service = new AdminOrdersService(prisma as never, attachments as never);
    prisma.$transaction.mockImplementation((fn: (client: typeof tx) => unknown) => fn(tx));
    log = jest.spyOn(Logger.prototype, 'log').mockImplementation();
  });

  afterEach(() => {
    jest.resetAllMocks();
    log.mockRestore();
  });

  describe('preview', () => {
    const found = {
      ...order(1, '1234-567890(1)'),
      manager: { name: 'Олена' },
      payments: [{ amount: d('60.00') }, { amount: d('40.50') }],
      _count: { refunds: 1, paymentDetails: 2, amountChanges: 3, attachments: 4 },
    };

    it('should normalize the number, count related rows and list the other parts', async () => {
      prisma.order.findUnique.mockResolvedValue(found);
      prisma.order.findMany.mockResolvedValue([order(2, '1234-567890')]);

      const preview = await service.preview(' 1234-567890 (1) ');

      expect(prisma.order.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({ where: { orderNumber: '1234-567890(1)' } }),
      );
      expect(prisma.order.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { baseNumber: '1234-567890', id: { not: 1 } } }),
      );
      expect(preview).toMatchObject({
        order_number: '1234-567890(1)',
        manager_name: 'Олена',
        payments_count: 2,
        payments_total: '100.50',
        refunds_count: 1,
        requisites_count: 2,
        amount_changes_count: 3,
        attachments_count: 4,
        sibling_parts: [{ order_number: '1234-567890', amount_due: '100.00', status: 'PAID' }],
      });
    });

    it('should fail with ORDER_NOT_FOUND for an unknown number', async () => {
      prisma.order.findUnique.mockResolvedValue(null);

      await rejectsWith(service.preview('0000-000000'), 'ORDER_NOT_FOUND');
    });
  });

  describe('remove', () => {
    const NUMBER = '1234-567890';
    const target = order(1, NUMBER);
    const arrange = (parts = [target]) => {
      tx.order.findUnique.mockResolvedValue({ baseNumber: NUMBER });
      tx.order.findMany.mockResolvedValue(parts);
      tx.refund.deleteMany.mockResolvedValue({ count: 1 });
      tx.orderRequisite.deleteMany.mockResolvedValue({ count: 2 });
      tx.orderAmountChange.deleteMany.mockResolvedValue({ count: 3 });
      tx.orderAttachment.findMany.mockResolvedValue([]);
      tx.orderAttachment.deleteMany.mockResolvedValue({ count: 0 });
      tx.payment.updateMany.mockResolvedValue({ count: 2 });
      tx.payment.deleteMany.mockResolvedValue({ count: 2 });
      tx.payment.aggregate.mockResolvedValue({ _sum: { amount: null } });
      tx.refund.aggregate.mockResolvedValue({ _sum: { amount: null } });
    };
    const dto = (overrides = {}) => ({
      confirm: NUMBER,
      payments: 'detach' as const,
      ...overrides,
    });

    beforeEach(() => arrange());

    it('should delete nothing when confirm differs from the order number', async () => {
      await rejectsWith(
        service.remove(NUMBER, dto({ confirm: '1234-567891' }), 'tool'),
        'CONFIRM_MISMATCH',
      );

      expect(prisma.$transaction).not.toHaveBeenCalled();
      expect(tx.order.delete).not.toHaveBeenCalled();
    });

    it('should fail with ORDER_NOT_FOUND when the order is missing', async () => {
      tx.order.findMany.mockResolvedValue([]);

      await rejectsWith(service.remove(NUMBER, dto(), 'tool'), 'ORDER_NOT_FOUND');
      expect(tx.order.delete).not.toHaveBeenCalled();
    });

    it('should detach payments and delete every other child row before the order', async () => {
      const result = await service.remove(NUMBER, dto(), 'tool');

      expect(tx.payment.updateMany).toHaveBeenCalledWith({
        where: { orderId: 1 },
        data: { orderId: null },
      });
      expect(tx.payment.deleteMany).not.toHaveBeenCalled();
      expect(tx.order.delete).toHaveBeenCalledWith({ where: { id: 1 } });
      const childOrder = tx.refund.deleteMany.mock.invocationCallOrder[0]!;
      expect(childOrder).toBeLessThan(tx.order.delete.mock.invocationCallOrder[0]!);
      expect(tx.orderRequisite.deleteMany).toHaveBeenCalledWith({ where: { orderId: 1 } });
      expect(tx.orderAmountChange.deleteMany).toHaveBeenCalledWith({ where: { orderId: 1 } });
      expect(result).toEqual({
        order_number: NUMBER,
        payments_detached: 2,
        payments_deleted: 0,
        refunds_deleted: 1,
        requisites_deleted: 2,
        amount_changes_deleted: 3,
        attachments_deleted: 0,
      });
    });

    it('should delete the payments when asked to', async () => {
      const result = await service.remove(NUMBER, dto({ payments: 'delete' }), 'tool');

      expect(tx.payment.deleteMany).toHaveBeenCalledWith({ where: { orderId: 1 } });
      expect(tx.payment.updateMany).not.toHaveBeenCalled();
      expect(result).toMatchObject({ payments_detached: 0, payments_deleted: 2 });
    });

    it('should resync the status of the parts that remain', async () => {
      const sibling = order(2, `${NUMBER}(1)`, OrderStatus.AWAITING_PAYMENT);
      arrange([target, sibling]);
      tx.payment.aggregate.mockResolvedValue({ _sum: { amount: d('100.00') } });
      tx.order.update.mockResolvedValue({ ...sibling, status: OrderStatus.PAID });

      await service.remove(NUMBER, dto(), 'tool');

      expect(tx.order.update).toHaveBeenCalledWith({
        where: { id: 2 },
        data: { status: OrderStatus.PAID },
      });
    });

    it('should drop Telegram messages after the transaction and survive their failure', async () => {
      const files = [{ id: 9 }, { id: 10 }];
      tx.orderAttachment.findMany.mockResolvedValue(files);
      tx.orderAttachment.deleteMany.mockResolvedValue({ count: 2 });
      let committed = false;
      prisma.$transaction.mockImplementation(async (fn: (client: typeof tx) => unknown) => {
        const value = await fn(tx);
        committed = true;
        return value;
      });
      attachments.discardMessage
        .mockRejectedValueOnce(new Error('telegram down'))
        .mockImplementationOnce(() => {
          expect(committed).toBe(true);
          return Promise.resolve();
        });

      const result = await service.remove(NUMBER, dto(), 'tool');

      expect(attachments.discardMessage).toHaveBeenCalledTimes(2);
      expect(result.attachments_deleted).toBe(2);
    });

    it('should log a snapshot of what was deleted', async () => {
      await service.remove(NUMBER, dto(), 'aber-tools');

      expect(log).toHaveBeenCalledWith(expect.stringContaining('"orderNumber":"1234-567890"'));
      expect(log).toHaveBeenCalledWith(expect.stringContaining('"actor":"aber-tools"'));
    });
  });
});
