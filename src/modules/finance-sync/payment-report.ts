import type { Prisma } from '../../generated/prisma/client';
import { escapeHtml, formatKyivPaidAt, formatMoneyIn } from '../telegram/core/format';

/** Stored when the manager gives no payer: the requisites and minus parsers use the same words. */
export const UNNAMED_PAYER = 'Не вказано';

export interface ReportedPayment {
  payerName: string;
  amount: Prisma.Decimal;
  paidAt: Date | null;
}

const uah = (value: Prisma.Decimal): string => formatMoneyIn(value, 'UAH');

export function paymentProgressLine(paid: Prisma.Decimal, due: Prisma.Decimal): string {
  if (paid.lessThan(due)) {
    return `💰 Оплачено ${uah(paid)} з ${uah(due)} · залишок ${uah(due.minus(paid))}`;
  }
  if (paid.equals(due)) return `✅ Оплачено повністю: ${uah(due)}`;
  return `✅ Оплачено ${uah(paid)} з ${uah(due)} · переплата ${uah(paid.minus(due))}`;
}

function paymentLine(payment: ReportedPayment, due: Prisma.Decimal): string {
  const parts = [
    ...(payment.payerName === UNNAMED_PAYER ? [] : [escapeHtml(payment.payerName)]),
    uah(payment.amount),
    ...(payment.paidAt ? [formatKyivPaidAt(payment.paidAt)] : []),
    ...(payment.amount.lessThan(due) ? ['частина'] : []),
  ];
  return `• ${parts.join(' · ')}`;
}

/** The report in «Оплати» for the payments the manager just added to a request's orders. */
export function paymentReportMessage(input: {
  orderNumbers: string[];
  clientName: string;
  managerName: string;
  added: ReportedPayment[];
  paid: Prisma.Decimal;
  due: Prisma.Decimal;
}): string {
  return [
    `💳 <b>Оплата</b> · № ${escapeHtml(input.orderNumbers.join(', '))}`,
    `<b>${escapeHtml(input.clientName)}</b>`,
    ...input.added.map((payment) => paymentLine(payment, input.due)),
    paymentProgressLine(input.paid, input.due),
    '',
    `Менеджер: ${escapeHtml(input.managerName)}`,
  ].join('\n');
}
