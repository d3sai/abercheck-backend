import { OrdersController } from '../../../src/modules/orders/orders.controller';
import type { FindUnpaidQueryDto } from '../../../src/modules/orders/dto/find-unpaid-query.dto';
import { Prisma } from '../../../src/generated/prisma/client';
import type { OrdersService } from '../../../src/modules/orders/orders.service';

const d = (value: string) => new Prisma.Decimal(value);

describe('OrdersController', () => {
  const orders = { findUnpaid: jest.fn() };
  const controller = new OrdersController(orders as unknown as OrdersService);

  afterEach(() => jest.resetAllMocks());

  it('should forward the limit and cursor to the service and map the response', async () => {
    orders.findUnpaid.mockResolvedValue({
      items: [
        {
          order: {
            orderNumber: '0000-066717',
            baseNumber: '0000-066717',
            clientName: 'Іваненко Іван',
            amountDue: d('1250.50'),
            status: 'AWAITING_PAYMENT',
            createdAt: new Date('2026-09-03T12:00:00Z'),
          },
          amountPaid: d('0'),
        },
      ],
      nextCursor: 42,
    });

    const query: FindUnpaidQueryDto = { limit: 50, cursor: 10 };
    const result = await controller.findUnpaid(query);

    expect(orders.findUnpaid).toHaveBeenCalledWith(50, 10);
    expect(result).toEqual({
      data: [
        {
          order_number: '0000-066717',
          order_numbers: ['0000-066717'],
          client_name: 'Іваненко Іван',
          amount_due: '1250.50',
          amount_paid: '0.00',
          amount_remaining: '1250.50',
          status: 'AWAITING_PAYMENT',
          created_at: '2026-09-03T12:00:00.000Z',
        },
      ],
      next_cursor: 42,
    });
  });

  it('should report no further pages with a null cursor', async () => {
    orders.findUnpaid.mockResolvedValue({ items: [], nextCursor: null });

    const result = await controller.findUnpaid({ limit: 200 });

    expect(result.next_cursor).toBeNull();
  });
});
