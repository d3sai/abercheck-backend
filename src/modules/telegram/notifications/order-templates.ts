import { type Manager, type Order, OrderType, Prisma } from '../../../generated/prisma/client';
import { escapeHtml, formatKyivDateTime, formatMoney } from '../core/format';

function formatRate(value: Prisma.Decimal): string {
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
    `№ <b>${escapeHtml(order.orderNumber)}</b>`,
    `ФОП: ${escapeHtml(order.clientName)}`,
    `Сума: ${formatMoney(order.amountDue)} грн`,
    ...(order.exchangeRate ? [`Курс: ${formatRate(order.exchangeRate)}`] : []),
    ...(order.comment ? [`Коментар: ${escapeHtml(order.comment)}`] : []),
    '',
    `Менеджер: ${escapeHtml(manager.name)}`,
    `Створено: ${formatKyivDateTime(order.createdAt)}`,
  ].join('\n');
}

export interface RequisitesNoticeExtras {
  /** Numbers left out because they already exist. */
  skipped?: string[];
  /** What was written after an amount on a number's line, by number: "(залишок)". */
  notes?: Record<string, string>;
}

// One notice for a whole payment to other requisites. Its sections follow the regular order notice:
// number(s), recipients (where the FOP is), amount, rate, comment, then who and when.
export function adminRequisitesMessage(
  orders: Order[],
  manager: Manager,
  { skipped = [], notes = {} }: RequisitesNoticeExtras = {},
): string {
  const [first] = orders;
  if (!first) {
    return '';
  }
  const total = orders.reduce((sum, order) => sum.plus(order.amountDue), new Prisma.Decimal(0));
  const isMinus = first.orderType === OrderType.MINUS_CLOSING;
  const title = isMinus
    ? '➖ <b>Закриття мінусу</b>'
    : first.orderNumber === first.baseNumber
      ? '💳 <b>Оплата на інші реквізити</b>'
      : '➕ <b>Оплата на інші реквізити · нова частина</b>';
  const noted = (text: string, number: string): string =>
    notes[number] ? `${text} ${escapeHtml(notes[number])}` : text;
  const numbers =
    orders.length > 1
      ? orders.map((order) =>
          noted(
            `№ <b>${escapeHtml(order.orderNumber)}</b> — ${formatMoney(order.amountDue)} грн`,
            order.orderNumber,
          ),
        )
      : isMinus
        ? []
        : [noted(`№ <b>${escapeHtml(first.orderNumber)}</b>`, first.orderNumber)];
  return [
    title,
    ...numbers,
    ...(first.requisites ? ['Реквізити:', `<pre>${escapeHtml(first.requisites)}</pre>`] : []),
    orders.length > 1 ? `Разом: ${formatMoney(total)} грн` : `Сума: ${formatMoney(total)} грн`,
    ...(first.exchangeRate ? [`Курс: ${formatRate(first.exchangeRate)}`] : []),
    ...(first.comment ? [`Коментар: ${escapeHtml(first.comment)}`] : []),
    ...(skipped.length > 0 ? [`Не додано (уже є в системі): ${skipped.join(', ')}`] : []),
    '',
    `Менеджер: ${escapeHtml(manager.name)}`,
    `Створено: ${formatKyivDateTime(first.createdAt)}`,
  ].join('\n');
}
