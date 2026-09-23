import {
  type Manager,
  type Order,
  OrderStatus,
  type Payment,
  Prisma,
} from '../../../generated/prisma/client';
import { escapeHtml, formatKyivDate, formatKyivDateTime, formatMoney } from '../core/format';

export interface PaymentNotice {
  order: Order;
  payment: Payment;
  payments: Payment[];
  amountPaid: Prisma.Decimal;
}

const money = (value: Prisma.Decimal) => `${formatMoney(value)} грн`;
const recipient = (payment: Payment) =>
  escapeHtml(payment.receivingAccount ?? 'отримувач невідомий');

function orderHeader(order: Order): string[] {
  return [
    `ФОП: <b>${escapeHtml(order.clientName)}</b>`,
    `Замовлення № ${escapeHtml(order.orderNumber)}`,
    `Сума замовлення: ${money(order.amountDue)}`,
  ];
}

function paymentLine(payment: Payment): string {
  return `${recipient(payment)} - ${formatMoney(payment.amount)} ${formatKyivDateTime(payment.paidAt)}`;
}

function paidInFull({ order, payments }: PaymentNotice): string {
  return [
    '🟢 <b>Оплату отримано</b>',
    ...orderHeader(order),
    '',
    ...payments.map(paymentLine),
    '',
    'Залишок: 0 грн',
    'Статус: ОПЛАЧЕНО ✅',
  ].join('\n');
}

function partial({ order, payment, payments, amountPaid }: PaymentNotice): string {
  return [
    '🔵 <b>Отримано часткову оплату</b>',
    ...orderHeader(order),
    `Отримано: ${money(payment.amount)} на ${recipient(payment)}`,
    ...(payments.length > 1 ? [`Сплачено всього: ${money(amountPaid)}`] : []),
    `Залишок: ${money(order.amountDue.minus(amountPaid))}`,
    'Статус: ЧАСТКОВА ОПЛАТА',
  ].join('\n');
}

function overpaid({ order, amountPaid }: PaymentNotice): string {
  return [
    '🟠 <b>Виявлено переплату</b>',
    ...orderHeader(order),
    `Отримано: ${money(amountPaid)}`,
    `Переплата: ${money(amountPaid.minus(order.amountDue))} ⚠️ Потрібна перевірка.`,
  ].join('\n');
}

function paidAfterCancel({ order, payment }: PaymentNotice): string {
  return [
    '❌ <b>Платіж за скасованим замовленням</b>',
    ...orderHeader(order),
    `Отримано: ${money(payment.amount)} на ${recipient(payment)}`,
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
    `Сума: ${money(payment.amount)}`,
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
