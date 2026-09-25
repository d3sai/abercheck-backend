import {
  Currency,
  OrderType,
  Prisma,
  type Order,
  type OrderRequisite,
} from '../../../../src/generated/prisma/client';
import {
  adminRequisitesMessage,
  requisitesCreatedReply,
  requisitesPreview,
  multipleOrRequisitesGuard,
} from '../../../../src/modules/telegram/order-draft/requisites.messages';
import type { RequisitesPlan } from '../../../../src/modules/telegram/order-draft/requisites.parser';
import { MENU_LABEL } from '../../../../src/modules/telegram/core/menu';

const d = (value: string) => new Prisma.Decimal(value);

const plan = (overrides: Partial<RequisitesPlan> = {}): RequisitesPlan => ({
  kind: 'single',
  currency: Currency.UAH,
  items: [{ number: '0000-066092', amount: d('6667'), note: null }],
  total: d('6667'),
  derivedTotal: false,
  rate: null,
  label: 'ФОП Носенко Роман',
  warnings: [],
  comment: null,
  requisiteLines: [],
  ...overrides,
});

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
  orderType: OrderType.REGULAR,
  status: 'AWAITING_PAYMENT',
  managerId: 7,
  createdAt: new Date('2026-09-07T11:59:00Z'),
  updatedAt: new Date('2026-09-07T11:59:00Z'),
  ...overrides,
});

describe('requisitesPreview — dollars', () => {
  it('should show the total, every number and every requisite in dollars', () => {
    const reply = requisitesPreview(
      plan({
        kind: 'group',
        currency: Currency.USD,
        items: [
          { number: '0000-068772', amount: d('100'), note: null },
          { number: '0000-068773', amount: d('50.5'), note: null },
        ],
        total: d('150.5'),
        requisiteLines: [
          {
            payerName: 'Носенко Роман',
            account: '5168 7451 7598 8366',
            amount: '150.50',
            paidAt: new Date('2026-09-07T11:57:00Z'),
          },
        ],
      }),
      { addsPart: false, skipped: [], files: 0 },
    );

    expect(reply.html).toContain('№ <b>0000-068772</b> — 100 $');
    expect(reply.html).toContain('Разом: <b>150,50 $</b>');
    expect(reply.html).toContain(
      '<pre>Носенко Роман\n5168 7451 7598 8366\n150,50 $\n14:57 07.09.2026</pre>',
    );
    expect(reply.html).not.toContain('грн');
  });

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

    expect(requisitesCreatedReply(orders, []).html).toContain('2 номерів · 150 $');
    const notice = adminRequisitesMessage(orders, 'Христина', [requisite({ amount: d('150') })]);
    expect(notice).toContain('№ <b>0000-068773</b> — 50 $');
    expect(notice).toContain('Разом: 150 $');
    expect(notice).toContain('150 $\n');
    expect(notice).not.toContain('грн');
  });
});

describe('requisitesPreview — requisite rendering', () => {
  it('should render a single requisite as one copyable <pre> block, fields on their own lines', () => {
    const reply = requisitesPreview(
      plan({
        requisiteLines: [
          {
            payerName: 'Носенко Роман',
            account: '5168 7451 7598 8366',
            amount: '4527.00',
            paidAt: new Date('2026-09-07T11:57:00Z'),
          },
        ],
      }),
      { addsPart: false, skipped: [], files: 0 },
    );

    expect(reply.html).toContain(
      '<pre>Носенко Роман\n5168 7451 7598 8366\n4 527 грн\n14:57 07.09.2026</pre>',
    );
  });

  it('should render two requisites as two separate <pre> blocks', () => {
    const reply = requisitesPreview(
      plan({
        requisiteLines: [
          {
            payerName: 'Носенко Роман',
            account: '5168 7451 7598 8366',
            amount: '4527.00',
            paidAt: new Date('2026-09-07T11:57:00Z'),
          },
          {
            payerName: 'Андріанов Олександр',
            account: '4441 1110 6964 5962',
            amount: '2140.00',
            paidAt: new Date('2026-09-07T11:59:00Z'),
          },
        ],
      }),
      { addsPart: false, skipped: [], files: 0 },
    );

    const blocks = [...reply.html.matchAll(/<pre>([\s\S]*?)<\/pre>/g)].map((m) => m[1]);
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toBe('Носенко Роман\n5168 7451 7598 8366\n4 527 грн\n14:57 07.09.2026');
    expect(blocks[1]).toBe('Андріанов Олександр\n4441 1110 6964 5962\n2 140 грн\n14:59 07.09.2026');
  });

  it('should omit the account line entirely when there is none', () => {
    const reply = requisitesPreview(
      plan({
        requisiteLines: [
          {
            payerName: 'ФОП Солтик Олександра Олегівна',
            account: null,
            amount: '4890.00',
            paidAt: new Date('2026-09-17T10:04:00Z'),
          },
        ],
      }),
      { addsPart: false, skipped: [], files: 0 },
    );

    const [block] = [...reply.html.matchAll(/<pre>([\s\S]*?)<\/pre>/g)].map((m) => m[1]);
    expect(block!.split('\n')).toEqual([
      'ФОП Солтик Олександра Олегівна',
      '4 890 грн',
      '13:04 17.09.2026',
    ]);
  });

  it('should escape HTML in a requisite field', () => {
    const reply = requisitesPreview(
      plan({
        requisiteLines: [
          {
            payerName: '<b>Хтось</b>',
            account: '<script>',
            amount: '100.00',
            paidAt: new Date('2026-09-07T11:57:00Z'),
          },
        ],
      }),
      { addsPart: false, skipped: [], files: 0 },
    );

    expect(reply.html).toContain('&lt;b&gt;Хтось&lt;/b&gt;');
    expect(reply.html).toContain('&lt;script&gt;');
    expect(reply.html).not.toContain('<script>');
  });

  it('should say nothing about requisites when there are none', () => {
    const reply = requisitesPreview(plan(), { addsPart: false, skipped: [], files: 0 });

    expect(reply.html).not.toContain('Реквізити');
    expect(reply.html).not.toContain('<pre>');
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

describe('multipleOrRequisitesGuard', () => {
  it('should name the current menu button and the /requisites command', () => {
    const reply = multipleOrRequisitesGuard();

    expect(reply.html).toContain(MENU_LABEL.Requisites);
    expect(reply.html).toContain('/requisites');
    expect(reply.buttons).toBeUndefined();
  });
});
