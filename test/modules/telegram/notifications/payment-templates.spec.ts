import {
  Currency,
  type Manager,
  MatchType,
  type Order,
  OrderStatus,
  OrderType,
  type Payment,
  Prisma,
} from '../../../../src/generated/prisma/client';
import {
  adminPaymentMessage,
  managerPaymentMessage,
  needsAdminAttention,
  type PaymentNotice,
  unknownPaymentMessage,
} from '../../../../src/modules/telegram/notifications/payment-templates';

const d = (value: string) => new Prisma.Decimal(value);

const order = (status: OrderStatus): Order => ({
  id: 1,
  orderNumber: '0000-066717',
  baseNumber: '0000-066717',
  clientName: 'Чернявський Владислав',
  amountDue: d('6158.41'),
  currency: Currency.UAH,
  exchangeRate: d('44.9'),
  comment: null,
  requisites: null,
  paidAt: null,
  ourFop: null,
  period: null,
  sheetUrl: null,
  orderType: OrderType.REGULAR,
  status,
  managerId: 1,
  createdAt: new Date(),
  updatedAt: new Date(),
});

const payment = (
  id: number,
  amount: string,
  receivingAccount: string,
  paidAt: string,
): Payment => ({
  id,
  externalTransactionId: `tx-${id}`,
  amount: d(amount),
  currency: Currency.UAH,
  payerName: 'Чернявський Владислав',
  receivingAccount,
  purposeText: 'Оплата за товар',
  paidAt: new Date(paidAt),
  reportedOrderNumber: '0000-066717',
  orderId: 1,
  matchType: MatchType.MATCHED_BY_PROVIDER,
  createdAt: new Date(),
});

const fop = payment(1, '3614.32', 'ФОП Гук В.С', '2026-09-03T12:00:00Z');
const tov = payment(2, '2544.09', 'ТОВ Абертайм', '2026-09-03T12:31:00Z');

const notice = (status: OrderStatus, payments: Payment[]): PaymentNotice => ({
  order: order(status),
  payment: payments[payments.length - 1]!,
  payments,
  amountPaid: payments.reduce((sum, p) => sum.plus(p.amount), d('0')),
});

describe('managerPaymentMessage', () => {
  it('should list every transfer when the order is paid in full', () => {
    expect(managerPaymentMessage(notice(OrderStatus.PAID, [fop, tov]))).toBe(
      [
        '🟢 <b>Оплату отримано</b>',
        '<b>Чернявський Владислав</b>',
        'Замовлення № 0000-066717',
        'Сума замовлення: 6 158,41 грн',
        '',
        'ФОП Гук В.С - 3 614,32 15:00 03.09.2026',
        'ТОВ Абертайм - 2 544,09 15:31 03.09.2026',
        '',
        'Залишок: 0 грн',
        'Статус: ОПЛАЧЕНО ✅',
      ].join('\n'),
    );
  });

  it('should show the received amount and what is left for a partial payment', () => {
    expect(managerPaymentMessage(notice(OrderStatus.PARTIALLY_PAID, [fop]))).toBe(
      [
        '🔵 <b>Отримано часткову оплату</b>',
        '<b>Чернявський Владислав</b>',
        'Замовлення № 0000-066717',
        'Сума замовлення: 6 158,41 грн',
        'Отримано: 3 614,32 грн на ФОП Гук В.С',
        'Залишок: 2 544,09 грн',
        'Статус: ЧАСТКОВА ОПЛАТА',
      ].join('\n'),
    );
  });

  it('should add the running total after several partial payments', () => {
    const small = payment(3, '1000', 'ФОП Гук В.С', '2026-09-03T13:00:00Z');

    expect(managerPaymentMessage(notice(OrderStatus.PARTIALLY_PAID, [fop, small]))).toContain(
      'Сплачено всього: 4 614,32 грн\nЗалишок: 1 544,09 грн',
    );
  });

  it('should show the exact overpayment', () => {
    const extra = payment(3, '50', 'ФОП Гук В.С', '2026-09-03T13:00:00Z');

    expect(managerPaymentMessage(notice(OrderStatus.OVERPAID, [fop, tov, extra]))).toBe(
      [
        '🟠 <b>Виявлено переплату</b>',
        '<b>Чернявський Владислав</b>',
        'Замовлення № 0000-066717',
        'Сума замовлення: 6 158,41 грн',
        'Отримано: 6 208,41 грн',
        'Переплата: 50 грн ⚠️ Потрібна перевірка.',
      ].join('\n'),
    );
  });

  it('should escape client data', () => {
    const message = managerPaymentMessage({
      ...notice(OrderStatus.PARTIALLY_PAID, [fop]),
      order: { ...order(OrderStatus.PARTIALLY_PAID), clientName: 'ТОВ <Роги & Копита>' },
    });

    expect(message).toContain('<b>ТОВ &lt;Роги &amp; Копита&gt;</b>');
  });
});

describe('admin messages', () => {
  it('should flag overpaid and cancelled orders for admins only', () => {
    expect(needsAdminAttention(OrderStatus.OVERPAID)).toBe(true);
    expect(needsAdminAttention(OrderStatus.CANCELLED)).toBe(true);
    expect(needsAdminAttention(OrderStatus.PAID)).toBe(false);
    expect(needsAdminAttention(OrderStatus.PARTIALLY_PAID)).toBe(false);
  });

  it('should name the responsible manager in the admin copy', () => {
    const manager = { name: 'Христина' } as Manager;

    expect(adminPaymentMessage(notice(OrderStatus.OVERPAID, [fop, tov]), manager)).toMatch(
      /\nМенеджер: Христина$/,
    );
  });

  it('should describe an unknown payment with the number the provider sent', () => {
    expect(
      unknownPaymentMessage({ ...tov, id: 42, orderId: null, reportedOrderNumber: '0000-099999' }),
    ).toBe(
      [
        '⚠️ <b>Невідомий платіж</b>',
        'Сума: 2 544,09 грн',
        'Платник: Чернявський Владислав',
        'Отримувач: ТОВ Абертайм',
        'Дата: 03.09.2026',
        'Призначення: Оплата за товар',
        'Вказаний номер: 0000-099999 (не знайдено)',
        '',
        '🔎 Не вдалося автоматично визначити замовлення. Платіж #42.',
      ].join('\n'),
    );
  });
});

describe('dollar payments', () => {
  const usdOrder: Order = {
    ...order(OrderStatus.PARTIALLY_PAID),
    amountDue: d('150'),
    currency: Currency.USD,
  };
  const usdPayment: Payment = {
    ...payment(4, '100', 'ФОП Гук В.С', '2026-09-03T12:00:00Z'),
    currency: Currency.USD,
  };

  it('should show every figure of a partial payment in dollars', () => {
    const message = managerPaymentMessage({
      order: usdOrder,
      payment: usdPayment,
      payments: [usdPayment],
      amountPaid: d('100'),
    });

    expect(message).toContain('Сума замовлення: 150 $');
    expect(message).toContain('Отримано: 100 $ на ФОП Гук В.С');
    expect(message).toContain('Залишок: 50 $');
    expect(message).not.toContain('грн');
  });

  it('should mark the dollar sign on every transfer line and the zero balance when paid in full', () => {
    const message = managerPaymentMessage({
      order: { ...usdOrder, status: OrderStatus.PAID },
      payment: usdPayment,
      payments: [usdPayment],
      amountPaid: d('150'),
    });

    expect(message).toContain('ФОП Гук В.С - 100 $ 15:00 03.09.2026');
    expect(message).toContain('Залишок: 0 $');
  });

  it('should show the amount of an unknown dollar payment in dollars', () => {
    expect(unknownPaymentMessage({ ...usdPayment, orderId: null })).toContain('Сума: 100 $');
  });
});
