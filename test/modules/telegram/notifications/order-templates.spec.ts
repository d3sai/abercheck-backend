import {
  type Manager,
  type Order,
  OrderType,
  Prisma,
} from '../../../../src/generated/prisma/client';
import { adminOrderCreatedMessage } from '../../../../src/modules/telegram/notifications/order-templates';

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
  paidAt: null,
  ourFop: null,
  period: null,
  sheetUrl: null,
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
    expect(message).toContain('№ 0000-067968(1)');
    expect(message).not.toContain('Нове замовлення');
  });

  it('should show the essentials for a bare order', () => {
    const message = adminOrderCreatedMessage(order(), manager);

    expect(message).toBe(
      [
        '🆕 <b>Нове замовлення</b>',
        'ФОП: <b>ФОП Берчатова Лариса</b>',
        '№ 0000-067968',
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

    expect(message).toContain('ФОП: <b>&lt;b&gt;Клієнт&lt;/b&gt;</b>');
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
