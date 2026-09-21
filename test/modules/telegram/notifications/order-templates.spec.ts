import {
  type Manager,
  type Order,
  OrderType,
  Prisma,
} from '../../../../src/generated/prisma/client';
import {
  adminOrderCreatedMessage,
  adminRequisitesMessage,
} from '../../../../src/modules/telegram/notifications/order-templates';

const d = (value: string) => new Prisma.Decimal(value);

const order = (overrides: Partial<Order> = {}): Order => ({
  id: 1,
  orderNumber: '0000-067968',
  baseNumber: '0000-067968',
  clientName: 'ФОП Берчатова Лариса',
  amountDue: d('170.10'),
  exchangeRate: null,
  comment: null,
  requisites: null,
  orderType: OrderType.REGULAR,
  status: 'AWAITING_PAYMENT',
  managerId: 7,
  createdAt: new Date('2026-09-12T09:57:00Z'),
  updatedAt: new Date('2026-09-12T09:57:00Z'),
  ...overrides,
});

const manager: Manager = {
  id: 7,
  telegramId: 5000000000n,
  name: 'Христина',
  username: 'khrystyna',
  status: 'ACTIVE',
  role: 'MANAGER',
  login: null,
  passwordHash: null,
  sessionVersion: 0,
  createdAt: new Date(),
};

describe('adminOrderCreatedMessage', () => {
  it('should announce one more part of a number under its own (n) number', () => {
    const message = adminOrderCreatedMessage(order({ orderNumber: '0000-067968(1)' }), manager);

    expect(message).toContain('➕ <b>Нова частина замовлення</b>');
    expect(message).toContain('№ <b>0000-067968(1)</b>');
    expect(message).not.toContain('Нове замовлення');
  });

  it('should show the essentials for a bare order', () => {
    const message = adminOrderCreatedMessage(order(), manager);

    expect(message).toBe(
      [
        '🆕 <b>Нове замовлення</b>',
        '№ <b>0000-067968</b>',
        'ФОП: ФОП Берчатова Лариса',
        'Сума: 170,10 грн',
        '',
        'Менеджер: Христина',
        'Створено: 12:57 12.09.2026',
      ].join('\n'),
    );
  });

  it('should add the rate without trailing zeros', () => {
    const message = adminOrderCreatedMessage(order({ exchangeRate: d('44.9000') }), manager);

    expect(message).toContain('Курс: 44,9\n');
  });

  it('should show a whole-number rate without a decimal part', () => {
    const message = adminOrderCreatedMessage(order({ exchangeRate: d('45.0000') }), manager);

    expect(message).toContain('Курс: 45\n');
  });

  it('should escape HTML in the client name', () => {
    const message = adminOrderCreatedMessage(order({ clientName: '<b>Клієнт</b>' }), manager);

    expect(message).toContain('ФОП: &lt;b&gt;Клієнт&lt;/b&gt;');
  });

  it('should add the comment when present', () => {
    const message = adminOrderCreatedMessage(order({ comment: 'Терміново' }), manager);

    expect(message).toContain('Коментар: Терміново\n');
  });

  it('should escape HTML in the comment', () => {
    const message = adminOrderCreatedMessage(order({ comment: '<b>ок</b>' }), manager);

    expect(message).toContain('Коментар: &lt;b&gt;ок&lt;/b&gt;');
  });

  it('should show a distinct header for a minus-closing order', () => {
    const message = adminOrderCreatedMessage(
      order({ orderType: OrderType.MINUS_CLOSING }),
      manager,
    );

    expect(message).toContain('➖ <b>Закриття мінусу</b>');
  });

  it('should omit the comment line when absent', () => {
    const message = adminOrderCreatedMessage(order(), manager);

    expect(message).not.toContain('Коментар');
  });
});

describe('adminRequisitesMessage', () => {
  const requisites = 'ФОП Гук <В.С.> - 500 грн 10:50\n4441 1110 6964 5962 Андріанов - 200 грн';

  it('should follow the sections of the regular order notice, with the details as they were written', () => {
    const message = adminRequisitesMessage(
      [
        order({
          orderType: OrderType.REQUISITES,
          exchangeRate: d('44.9'),
          requisites,
          comment: '07.09.2026',
        }),
      ],
      manager,
    );

    expect(message).toBe(
      [
        '💳 <b>Оплата на інші реквізити</b>',
        '№ <b>0000-067968</b>',
        'Реквізити:',
        '<pre>ФОП Гук &lt;В.С.&gt; - 500 грн 10:50\n4441 1110 6964 5962 Андріанов - 200 грн</pre>',
        'Сума: 170,10 грн',
        'Курс: 44,9',
        'Коментар: 07.09.2026',
        '',
        'Менеджер: Христина',
        'Створено: 12:57 12.09.2026',
      ].join('\n'),
    );
  });

  it('should leave out the sections that are empty', () => {
    const message = adminRequisitesMessage([order({ orderType: OrderType.REQUISITES })], manager);

    expect(message).not.toContain('Реквізити:');
    expect(message).not.toContain('Курс');
    expect(message).not.toContain('Коментар');
  });

  it('should list every number of a group with its amount and note, then the total', () => {
    const group = [
      order({
        orderType: OrderType.REQUISITES,
        orderNumber: '0000-000001',
        baseNumber: '0000-000001',
        amountDue: d('335.58'),
        requisites: 'Гук Віктор Степанович ФОП',
        comment: '18.09.2026 21:28',
      }),
      order({
        orderType: OrderType.REQUISITES,
        orderNumber: '0000-000002',
        baseNumber: '0000-000001',
        amountDue: d('971.83'),
        comment: 'Оплата разом із № 0000-000001',
      }),
    ];

    const message = adminRequisitesMessage(group, manager, {
      notes: { '0000-000001': '(залишок)' },
    });

    expect(message).toBe(
      [
        '💳 <b>Оплата на інші реквізити</b>',
        '№ <b>0000-000001</b> — 335,58 грн (залишок)',
        '№ <b>0000-000002</b> — 971,83 грн',
        'Реквізити:',
        '<pre>Гук Віктор Степанович ФОП</pre>',
        'Разом: 1 307,41 грн',
        'Коментар: 18.09.2026 21:28',
        '',
        'Менеджер: Христина',
        'Створено: 12:57 12.09.2026',
      ].join('\n'),
    );
  });

  it('should title a closing minus without a number', () => {
    const message = adminRequisitesMessage(
      [
        order({
          orderType: OrderType.MINUS_CLOSING,
          orderNumber: 'МІНУС-1',
          baseNumber: 'МІНУС-1',
          comment: 'Закрила Любов Андрейчук',
        }),
      ],
      manager,
    );

    expect(message).toContain('➖ <b>Закриття мінусу</b>');
    expect(message).toContain('Коментар: Закрила Любов Андрейчук');
    expect(message).not.toContain('№');
  });

  it('should mark one more part of an existing number and name what was left out', () => {
    const message = adminRequisitesMessage(
      [order({ orderType: OrderType.REQUISITES, orderNumber: '0000-067968(1)' })],
      manager,
      { skipped: ['0000-000009'] },
    );

    expect(message).toContain('➕ <b>Оплата на інші реквізити · нова частина</b>');
    expect(message).toContain('Не додано (уже є в системі): 0000-000009');
  });
});
