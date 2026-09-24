import {
  type Order,
  OrderStatus,
  OrderType,
  Prisma,
  type Refund,
  RefundType,
} from '../../../../src/generated/prisma/client';
import {
  managerCancelMessage,
  managerRefundMessage,
} from '../../../../src/modules/telegram/notifications/refund-templates';

const d = (value: string) => new Prisma.Decimal(value);

const order = (overrides: Partial<Order> = {}): Order => ({
  id: 1,
  orderNumber: '0000-066717',
  baseNumber: '0000-066717',
  clientName: 'ФОП Гук В.С',
  amountDue: d('6158.41'),
  exchangeRate: null,
  comment: null,
  requisites: null,
  paidAt: null,
  ourFop: null,
  period: null,
  sheetUrl: null,
  orderType: OrderType.REGULAR,
  status: OrderStatus.PARTIALLY_PAID,
  managerId: 7,
  createdAt: new Date(),
  updatedAt: new Date(),
  ...overrides,
});

const refund = (overrides: Partial<Refund> = {}): Refund => ({
  id: 1,
  orderId: 1,
  amount: d('50'),
  type: RefundType.PARTIAL,
  initiatedByTelegramId: 111n,
  initiatedByName: 'Уляна',
  note: null,
  createdAt: new Date(),
  ...overrides,
});

describe('managerRefundMessage', () => {
  it('should describe the refund, the resulting balance and who did it', () => {
    const message = managerRefundMessage({
      refund: refund(),
      order: order({ status: OrderStatus.PARTIALLY_PAID }),
      previousStatus: OrderStatus.PAID,
      amountPaid: d('6108.41'),
    });

    expect(message).toBe(
      [
        '↩️ <b>Оформлено повернення</b>',
        'ФОП: <b>ФОП Гук В.С</b>',
        'Замовлення № 0000-066717',
        'Сума замовлення: 6 158,41 грн',
        'Повернено: 50 грн',
        'Сплачено чистими: 6 108,41 грн',
        'Статус: 🔵 Часткова оплата',
        'Оформив(ла): Уляна',
      ].join('\n'),
    );
  });

  it('should escape HTML in the client name and initiator name', () => {
    const message = managerRefundMessage({
      refund: refund({ initiatedByName: '<b>x</b>' }),
      order: order({ clientName: '<i>y</i>' }),
      previousStatus: OrderStatus.PAID,
      amountPaid: d('0'),
    });

    expect(message).toContain('ФОП: <b>&lt;i&gt;y&lt;/i&gt;</b>');
    expect(message).toContain('Оформив(ла): &lt;b&gt;x&lt;/b&gt;');
  });
});

describe('managerCancelMessage', () => {
  it('should name the order and who cancelled it', () => {
    const message = managerCancelMessage({
      order: order(),
      previousStatus: OrderStatus.AWAITING_PAYMENT,
      initiator: { telegramId: 111n, name: 'Уляна' },
    });

    expect(message).toBe(
      [
        '❌ <b>Замовлення скасовано</b>',
        'ФОП: <b>ФОП Гук В.С</b>',
        'Замовлення № 0000-066717',
        'Скасував(ла): Уляна',
      ].join('\n'),
    );
  });

  it('should escape HTML in the initiator name', () => {
    const message = managerCancelMessage({
      order: order(),
      previousStatus: OrderStatus.AWAITING_PAYMENT,
      initiator: { telegramId: 111n, name: '<b>x</b>' },
    });

    expect(message).toContain('Скасував(ла): &lt;b&gt;x&lt;/b&gt;');
  });
});
