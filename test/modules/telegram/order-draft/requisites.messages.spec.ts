import {
  Currency,
  OrderType,
  Prisma,
  type Order,
  type OrderRequisite,
} from '../../../../src/generated/prisma/client';
import { adminRequisitesMessage } from '../../../../src/modules/telegram/order-draft/requisites.messages';

const d = (value: string) => new Prisma.Decimal(value);

const requisite = (overrides: Partial<OrderRequisite> = {}): OrderRequisite => ({
  id: 1,
  orderId: 1,
  payerName: 'Носенко Роман',
  account: '5168 7451 7598 8366',
  amount: d('4527.00'),
  paidAt: new Date('2026-09-07T11:57:00Z'),
  addedByTelegramId: 5000000000n,
  addedByName: 'Христина',
  createdAt: new Date('2026-09-07T11:58:00Z'),
  ...overrides,
});

const order = (overrides: Partial<Order> = {}): Order => ({
  id: 1,
  orderNumber: '0000-066092',
  baseNumber: '0000-066092',
  clientName: 'Носенко Роман',
  amountDue: d('6667.00'),
  currency: Currency.UAH,
  exchangeRate: null,
  comment: null,
  requisites: null,
  paidAt: null,
  ourFop: null,
  period: null,
  sheetUrl: null,
  adminMessageId: null,
  orderType: OrderType.REGULAR,
  status: 'AWAITING_PAYMENT',
  managerId: 7,
  createdAt: new Date('2026-09-07T11:59:00Z'),
  updatedAt: new Date('2026-09-07T11:59:00Z'),
  ...overrides,
});

describe('adminRequisitesMessage — dollars', () => {
  it('should show the created orders and the admin notice in dollars', () => {
    const orders = [
      order({
        orderNumber: '0000-068772',
        baseNumber: '0000-068772',
        amountDue: d('100'),
        currency: Currency.USD,
      }),
      order({
        orderNumber: '0000-068773',
        baseNumber: '0000-068772',
        amountDue: d('50'),
        currency: Currency.USD,
      }),
    ];

    const notice = adminRequisitesMessage(orders, 'Христина', [requisite({ amount: d('150') })]);
    expect(notice).toContain('№ <b>0000-068773</b> — 50 $');
    expect(notice).toContain('Разом: 150 $');
    expect(notice).toContain('150 $\n');
    expect(notice).not.toContain('грн');
  });
});

describe('adminRequisitesMessage — requisite rendering', () => {
  it('should render each requisite as its own copyable block, same as the preview', () => {
    const notice = adminRequisitesMessage(
      [order()],
      'Христина',
      [
        requisite(),
        requisite({
          id: 2,
          payerName: 'Андріанов Олександр',
          account: '4441 1110 6964 5962',
          amount: d('2140.00'),
          paidAt: new Date('2026-09-07T11:59:00Z'),
        }),
      ],
      [],
    );

    const blocks = [...notice.matchAll(/<pre>([\s\S]*?)<\/pre>/g)].map((m) => m[1]);
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toBe('Носенко Роман\n5168 7451 7598 8366\n4 527 грн\n14:57 07.09.2026');
    expect(blocks[1]).toBe('Андріанов Олександр\n4441 1110 6964 5962\n2 140 грн\n14:59 07.09.2026');
  });

  it('should not render a requisites section when none were given', () => {
    const notice = adminRequisitesMessage([order()], 'Христина', [], []);

    expect(notice).not.toContain('Реквізити');
    expect(notice).not.toContain('<pre>');
  });
});

describe('several rates in one message', () => {
  it('should show the rate next to each number in the admin notice only when they differ', () => {
    const orders = (second: string) => [
      order({ orderNumber: '0000-072475', baseNumber: '0000-072475', exchangeRate: d('44') }),
      order({ orderNumber: '0000-072477', baseNumber: '0000-072475', exchangeRate: d(second) }),
    ];

    const different = adminRequisitesMessage(orders('45.3'), 'Христина', []);
    const same = adminRequisitesMessage(orders('44'), 'Христина', []);

    expect(different).toContain('№ <b>0000-072475</b> — 6 667 грн · курс 44');
    expect(different).toContain('№ <b>0000-072477</b> — 6 667 грн · курс 45,3');
    expect(different).not.toContain('Курс:');
    expect(same).toContain('Курс: 44');
    expect(same).not.toContain('· курс');
  });
});
