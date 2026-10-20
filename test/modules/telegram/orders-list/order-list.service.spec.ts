import { OrderStatus, Prisma } from '../../../../src/generated/prisma/client';
import { OrderListService } from '../../../../src/modules/telegram/orders-list/order-list.service';
import {
  LIST_LIMIT,
  UNMATCHED_LIMIT,
} from '../../../../src/modules/telegram/orders-list/orders-list.messages';

const d = (value: string) => new Prisma.Decimal(value);

const OPEN_STATUSES = [
  OrderStatus.AWAITING_PAYMENT,
  OrderStatus.PARTIALLY_PAID,
  OrderStatus.UNDERPAID,
  OrderStatus.OVERPAID,
];

describe('OrderListService', () => {
  const orders = { list: jest.fn() };
  const payments = { findUnmatched: jest.fn() };
  const service = new OrderListService(orders as never, payments as never);

  beforeEach(() => {
    orders.list.mockResolvedValue({ items: [], total: 0 });
    payments.findUnmatched.mockResolvedValue({ payments: [], total: 0 });
  });

  afterEach(() => jest.resetAllMocks());

  describe('forManager', () => {
    it('should offer a delete button only for unpaid orders', async () => {
      const item = (orderNumber: string, status: OrderStatus, paid: string) => ({
        order: {
          orderNumber,
          status,
          createdAt: new Date('2026-10-01T10:00:00Z'),
          clientName: 'ФОП',
          amountDue: d('100.00'),
          currency: 'UAH',
        },
        amountPaid: d(paid),
      });
      orders.list.mockResolvedValue({
        items: [
          item('1111-111111', OrderStatus.AWAITING_PAYMENT, '0'),
          item('2222-222222', OrderStatus.PARTIALLY_PAID, '40'),
        ],
        total: 2,
      });

      const reply = await service.forManager(7, false);

      expect(reply.buttons).toEqual([
        [{ text: '🗑 Видалити 1111-111111', callback_data: 'del:1111-111111' }],
      ]);
    });

    it("should filter to this manager's open orders by default", async () => {
      const reply = await service.forManager(7, false);

      expect(orders.list).toHaveBeenCalledWith(
        { managerId: 7, statuses: OPEN_STATUSES },
        LIST_LIMIT,
      );
      expect(reply.html).toContain('Мої відкриті замовлення');
    });

    it('should drop the status filter when asked for all orders', async () => {
      await service.forManager(7, true);

      expect(orders.list).toHaveBeenCalledWith({ managerId: 7, statuses: undefined }, LIST_LIMIT);
    });

    it('should title the reply for "all" and not include unmatched payments', async () => {
      const reply = await service.forManager(7, true);

      expect(reply.html).toContain('Мої замовлення');
      expect(reply.html).not.toContain('Невідомі платежі');
      expect(payments.findUnmatched).not.toHaveBeenCalled();
    });
  });

  describe('forAdmins', () => {
    it('should list open orders across all managers plus unmatched payments', async () => {
      orders.list.mockResolvedValue({
        items: [
          {
            order: {
              orderNumber: '0000-066717',
              status: OrderStatus.AWAITING_PAYMENT,
              createdAt: new Date('2026-09-03T09:00:00Z'),
              clientName: 'Гук В.С',
              amountDue: d('6158.41'),
              manager: { name: 'Христина' },
            },
            amountPaid: d('0'),
          },
        ],
        total: 1,
      });
      payments.findUnmatched.mockResolvedValue({
        payments: [{ id: 5, paidAt: new Date(), amount: d('100'), payerName: 'X' }],
        total: 1,
      });

      const reply = await service.forAdmins(false);

      expect(orders.list).toHaveBeenCalledWith({ statuses: OPEN_STATUSES }, LIST_LIMIT);
      expect(payments.findUnmatched).toHaveBeenCalledWith(UNMATCHED_LIMIT);
      expect(reply.html).toContain('Відкриті замовлення');
      expect(reply.html).toContain('Невідомі платежі');
      expect(reply.buttons).toEqual([[{ text: "🔗 Прив'язати #5", callback_data: 'attach:5' }]]);
    });

    it('should title the reply "Усі замовлення" and drop the status filter for "all"', async () => {
      const reply = await service.forAdmins(true);

      expect(orders.list).toHaveBeenCalledWith({ statuses: undefined }, LIST_LIMIT);
      expect(reply.html).toContain('Усі замовлення');
    });
  });
});
