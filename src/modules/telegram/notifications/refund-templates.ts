import type { OrderCancelled, RefundRecorded } from '../../refunds/refund.events';
import { escapeHtml, formatMoney } from '../core/format';
import { statusLabel } from '../orders-list/status-labels';

export function managerRefundMessage({ refund, order, amountPaid }: RefundRecorded): string {
  return [
    '↩️ <b>Оформлено повернення</b>',
    `ФОП: <b>${escapeHtml(order.clientName)}</b>`,
    `Замовлення № ${escapeHtml(order.orderNumber)}`,
    `Сума замовлення: ${formatMoney(order.amountDue)} грн`,
    `Повернено: ${formatMoney(refund.amount)} грн`,
    `Сплачено чистими: ${formatMoney(amountPaid)} грн`,
    `Статус: ${statusLabel(order.status)}`,
    `Оформив(ла): ${escapeHtml(refund.initiatedByName)}`,
  ].join('\n');
}

export function managerCancelMessage({ order, initiator }: OrderCancelled): string {
  return [
    '❌ <b>Замовлення скасовано</b>',
    `ФОП: <b>${escapeHtml(order.clientName)}</b>`,
    `Замовлення № ${escapeHtml(order.orderNumber)}`,
    `Скасував(ла): ${escapeHtml(initiator.name)}`,
  ].join('\n');
}
