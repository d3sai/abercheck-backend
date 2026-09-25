import { type Manager, type Order, OrderType, type Prisma } from '../../../generated/prisma/client';
import { escapeHtml, formatKyivDateTime, formatMoneyIn } from '../core/format';

export function formatRate(value: Prisma.Decimal): string {
  return value.toFixed(4).replace(/0+$/, '').replace(/\.$/, '').replace('.', ',');
}

export function adminOrderCreatedMessage(order: Order, manager: Manager): string {
  const title =
    order.orderType === OrderType.MINUS_CLOSING
      ? '➖ <b>Закриття мінусу</b>'
      : order.orderNumber === order.baseNumber
        ? '🆕 <b>Нове замовлення</b>'
        : '➕ <b>Нова частина замовлення</b>';
  return [
    title,
    // Managers usually write "ФОП …" into the name themselves, so no label of our own.
    `<b>${escapeHtml(order.clientName)}</b>`,
    `№ ${escapeHtml(order.orderNumber)}`,
    `Сума: ${formatMoneyIn(order.amountDue, order.currency)}`,
    ...(order.exchangeRate ? [`Курс: ${formatRate(order.exchangeRate)}`] : []),
    ...(order.comment ? [`Коментар: ${escapeHtml(order.comment)}`] : []),
    '',
    `Менеджер: ${escapeHtml(manager.name)}`,
    `Створено: ${formatKyivDateTime(order.createdAt)}`,
  ].join('\n');
}
