import { OrderStatus, Prisma } from '../../../../src/generated/prisma/client';
import type {
  OrderWithManager,
  OrderWithPaid,
} from '../../../../src/modules/orders/orders.service';
import { orderList } from '../../../../src/modules/telegram/orders-list/orders-list.messages';

const d = (value: string) => new Prisma.Decimal(value);

const item = (
  orderNumber: string,
  status: OrderStatus,
  amountDue: string,
  amountPaid: string,
): OrderWithPaid<OrderWithManager> =>
  ({
    order: {
      orderNumber,
      baseNumber: orderNumber,
      status,
      amountDue: d(amountDue),
      clientName: 'Петренко',
      createdAt: new Date('2026-09-03T09:00:00Z'),
      manager: { name: 'Христина' },
    },
    amountPaid: d(amountPaid),
  }) as OrderWithPaid<OrderWithManager>;

describe('orderList', () => {
  const items = [
    item('0000-066717', OrderStatus.PARTIALLY_PAID, '6158.41', '3614.32'),
    item('0000-066718', OrderStatus.OVERPAID, '1000', '1050'),
  ];

  it('should show each order with its balance like the admin cabinet', () => {
    const { html, buttons } = orderList({
      title: 'Мої відкриті замовлення',
      items,
      total: 2,
      withManager: false,
    });

    expect(html).toBe(
      [
        '<b>Мої відкриті замовлення</b> · 2',
        '',
        '🔵 <b>0000-066717</b> · 03.09 · Петренко',
        '6 158,41 грн · сплачено 3 614,32 · залишок 2 544,09',
        '',
        '🟠 <b>0000-066718</b> · 03.09 · Петренко',
        '1 000 грн · сплачено 1 050 · переплата 50',
      ].join('\n'),
    );
    expect(buttons).toBeUndefined();
  });

  it('should add the manager and unknown payments with attach buttons for admins', () => {
    const { html, buttons } = orderList({
      title: 'Відкриті замовлення',
      items: items.slice(0, 1),
      total: 30,
      withManager: true,
      unmatched: {
        total: 1,
        payments: [
          {
            id: 15,
            amount: d('2500'),
            payerName: 'Сидоренко Олена',
            paidAt: new Date('2026-09-03T12:00:00Z'),
          } as never,
        ],
      },
    });

    expect(html).toContain('<b>Відкриті замовлення</b> · показано 1 з 30');
    expect(html).toContain('🔵 <b>0000-066717</b> · 03.09 · Петренко · Христина');
    expect(html).toContain('#15 · 03.09 · 2 500 грн · Сидоренко Олена');
    expect(buttons).toEqual([[{ text: "🔗 Прив'язати #15", callback_data: 'attach:15' }]]);
  });

  it('should say so when there is nothing to show', () => {
    expect(
      orderList({ title: 'Мої замовлення', items: [], total: 0, withManager: false }).html,
    ).toContain('Замовлень немає.');
  });
});
