import { Currency, OrderStatus, Prisma } from '../../../../src/generated/prisma/client';
import { OrderDeleteService } from '../../../../src/modules/telegram/orders-list/order-delete.service';

const manager = { id: 7, name: 'Христина' } as never;

const found = (overrides: Record<string, unknown> = {}) => ({
  orderNumber: '1234-567890',
  clientName: 'ФОП Іваненко',
  amountDue: new Prisma.Decimal('100.00'),
  currency: Currency.UAH,
  status: OrderStatus.AWAITING_PAYMENT,
  managerId: 7,
  adminMessageId: 500,
  attachments: [{ telegramMessageId: 501 }, { telegramMessageId: 502 }],
  _count: { payments: 0, refunds: 0 },
  ...overrides,
});

describe('OrderDeleteService', () => {
  const prisma = { order: { findUnique: jest.fn() } };
  const adminOrders = { remove: jest.fn() };
  const sender = { deleteAdminMessage: jest.fn() };
  const service = new OrderDeleteService(prisma as never, adminOrders as never, sender as never);

  afterEach(() => jest.resetAllMocks());

  describe('ask', () => {
    it('should offer a confirmation for the manager’s own unpaid order', async () => {
      prisma.order.findUnique.mockResolvedValue(found());

      const reply = await service.ask(manager, '1234-567890', 31);

      expect(reply.html).toContain('Видалити замовлення');
      expect(reply.buttons?.[0]?.[0]).toMatchObject({ callback_data: 'delok:1234-567890:31' });
      expect(adminOrders.remove).not.toHaveBeenCalled();
    });

    it.each([
      ['another manager', { managerId: 9 }],
      ['a paid order', { status: OrderStatus.PAID }],
      ['an order with a payment', { _count: { payments: 1, refunds: 0 } }],
      ['an order with a refund', { _count: { payments: 0, refunds: 1 } }],
    ])('should refuse %s', async (_name, overrides) => {
      prisma.order.findUnique.mockResolvedValue(found(overrides));

      const reply = await service.ask(manager, '1234-567890', 31);

      expect(reply.html).toContain('не можна видалити самостійно');
      expect(reply.buttons).toBeUndefined();
    });

    it('should refuse an unknown order', async () => {
      prisma.order.findUnique.mockResolvedValue(null);

      expect((await service.ask(manager, '0000-000000', 31)).html).toContain('не можна видалити');
    });
  });

  describe('confirm', () => {
    it('should delete from the database keeping late payments, then from the admin chat', async () => {
      prisma.order.findUnique.mockResolvedValue(found());

      const reply = await service.confirm(manager, '1234-567890');

      expect(adminOrders.remove).toHaveBeenCalledWith(
        '1234-567890',
        { confirm: '1234-567890', payments: 'detach' },
        'manager:Христина',
      );
      expect((sender.deleteAdminMessage.mock.calls as number[][]).map(([id]) => id)).toEqual([
        500, 501, 502,
      ]);
      expect(reply.html).toContain('видалено');
    });

    it('should skip the notice message when none was stored', async () => {
      prisma.order.findUnique.mockResolvedValue(found({ adminMessageId: null, attachments: [] }));

      await service.confirm(manager, '1234-567890');

      expect(sender.deleteAdminMessage).not.toHaveBeenCalled();
    });

    it('should delete nothing when the order is no longer deletable', async () => {
      prisma.order.findUnique.mockResolvedValue(found({ status: OrderStatus.PARTIALLY_PAID }));

      await service.confirm(manager, '1234-567890');

      expect(adminOrders.remove).not.toHaveBeenCalled();
      expect(sender.deleteAdminMessage).not.toHaveBeenCalled();
    });
  });
});
