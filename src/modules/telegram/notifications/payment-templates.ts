import {
  Currency,
  type Manager,
  type Order,
  OrderStatus,
  type Payment,
  Prisma,
} from '../../../generated/prisma/client';
import {
  escapeHtml,
  formatKyivDate,
  formatKyivDateTime,
  formatMoney,
  formatMoneyIn as money,
} from '../core/format';

export interface PaymentNotice {
  order: Order;
  payment: Payment;
  payments: Payment[];
  amountPaid: Prisma.Decimal;
}

const recipient = (payment: Payment) =>
  escapeHtml(payment.receivingAccount ?? 'отримувач невідомий');

function orderHeader(order: Order): string[] {
  return [
    `<b>${escapeHtml(order.clientName)}</b>`,
    `Замовлення № ${escapeHtml(order.orderNumber)}`,
    `Сума замовлення: ${money(order.amountDue, order.currency)}`,
  ];
}

function paymentLine(payment: Payment): string {
  const amount =
    payment.currency === Currency.USD
      ? money(payment.amount, payment.currency)
      : formatMoney(payment.amount);
  return `${recipient(payment)} - ${amount} ${formatKyivDateTime(payment.paidAt)}`;
}

function paidInFull({ order, payments }: PaymentNotice): string {
  return [
    '🟢 <b>Оплату отримано</b>',
    ...orderHeader(order),
    '',
    ...payments.map(paymentLine),
    '',
    `Залишок: ${money(new Prisma.Decimal(0), order.currency)}`,
    'Статус: ОПЛАЧЕНО ✅',
  ].join('\n');
}

function partial({ order, payment, payments, amountPaid }: PaymentNotice): string {
  return [
    '🔵 <b>Отримано часткову оплату</b>',
    ...orderHeader(order),
    `Отримано: ${money(payment.amount, order.currency)} на ${recipient(payment)}`,
    ...(payments.length > 1 ? [`Сплачено всього: ${money(amountPaid, order.currency)}`] : []),
    `Залишок: ${money(order.amountDue.minus(amountPaid), order.currency)}`,
    'Статус: ЧАСТКОВА ОПЛАТА',
  ].join('\n');
}

function overpaid({ order, amountPaid }: PaymentNotice): string {
  return [
    '🟠 <b>Виявлено переплату</b>',
    ...orderHeader(order),
    `Отримано: ${money(amountPaid, order.currency)}`,
    `Переплата: ${money(amountPaid.minus(order.amountDue), order.currency)} ⚠️ Потрібна перевірка.`,
  ].join('\n');
}

function paidAfterCancel({ order, payment }: PaymentNotice): string {
  return [
    '❌ <b>Платіж за скасованим замовленням</b>',
    ...orderHeader(order),
    `Отримано: ${money(payment.amount, order.currency)} на ${recipient(payment)}`,
    '⚠️ Потрібна перевірка.',
  ].join('\n');
}

export function managerPaymentMessage(notice: PaymentNotice): string {
  switch (notice.order.status) {
    case OrderStatus.PAID:
      return paidInFull(notice);
    case OrderStatus.OVERPAID:
      return overpaid(notice);
    case OrderStatus.CANCELLED:
      return paidAfterCancel(notice);
    default:
      return partial(notice);
  }
}

export function needsAdminAttention(status: OrderStatus): boolean {
  return status === OrderStatus.OVERPAID || status === OrderStatus.CANCELLED;
}

export function adminPaymentMessage(notice: PaymentNotice, manager: Manager): string {
  return `${managerPaymentMessage(notice)}\nМенеджер: ${escapeHtml(manager.name)}`;
}

export function unknownPaymentMessage(payment: Payment): string {
  return [
    '⚠️ <b>Невідомий платіж</b>',
    `Сума: ${money(payment.amount, payment.currency)}`,
    `Платник: ${escapeHtml(payment.payerName ?? '—')}`,
    `Отримувач: ${recipient(payment)}`,
    `Дата: ${formatKyivDate(payment.paidAt)}`,
    `Призначення: ${payment.purposeText?.trim() ? escapeHtml(payment.purposeText) : '—'}`,
    ...(payment.reportedOrderNumber
      ? [`Вказаний номер: ${escapeHtml(payment.reportedOrderNumber)} (не знайдено)`]
      : []),
    '',
    `🔎 Не вдалося автоматично визначити замовлення. Платіж #${payment.id}.`,
  ].join('\n');
}
