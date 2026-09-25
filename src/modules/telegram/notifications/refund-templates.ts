import type { OrderCancelled, RefundRecorded } from '../../refunds/refund.events';
import { escapeHtml, formatMoneyIn as money } from '../core/format';
import { statusLabel } from '../orders-list/status-labels';

export function managerRefundMessage({ refund, order, amountPaid }: RefundRecorded): string {
  return [
    '↩️ <b>Оформлено повернення</b>',
    `<b>${escapeHtml(order.clientName)}</b>`,
    `Замовлення № ${escapeHtml(order.orderNumber)}`,
    `Сума замовлення: ${money(order.amountDue, order.currency)}`,
    `Повернено: ${money(refund.amount, order.currency)}`,
    `Сплачено чистими: ${money(amountPaid, order.currency)}`,
    `Статус: ${statusLabel(order.status)}`,
    `Оформив(ла): ${escapeHtml(refund.initiatedByName)}`,
  ].join('\n');
}

export function managerCancelMessage({ order, initiator }: OrderCancelled): string {
  return [
    '❌ <b>Замовлення скасовано</b>',
    `<b>${escapeHtml(order.clientName)}</b>`,
    `Замовлення № ${escapeHtml(order.orderNumber)}`,
    `Скасував(ла): ${escapeHtml(initiator.name)}`,
  ].join('\n');
}
