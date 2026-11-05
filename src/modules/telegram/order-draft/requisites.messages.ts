import {
  type Currency,
  type Order,
  type OrderRequisite,
  Prisma,
} from '../../../generated/prisma/client';
import type { BotReply } from '../core/bot-reply';
import { escapeHtml, formatKyivDateTime, formatMoneyIn as money } from '../core/format';
import { formatRate } from '../notifications/order-templates';

export function requisiteBlock(
  payerName: string,
  account: string | null,
  amount: Prisma.Decimal,
  currency: Currency,
  paidAt: Date,
): string {
  const fields = [
    payerName,
    ...(account ? [account] : []),
    money(amount, currency),
    formatKyivDateTime(paidAt),
  ];
  return `<pre>${fields.map(escapeHtml).join('\n')}</pre>`;
}

export function requisitesErrors(errors: string[]): BotReply {
  return {
    html: [
      '⚠️ Потрібно виправити повідомлення:',
      ...errors.map((error) => `• ${escapeHtml(error)}`),
      'Після виправлення надішліть його ще раз.',
    ].join('\n'),
  };
}

export function adminRequisitesMessage(
  orders: Order[],
  managerName: string,
  requisites: OrderRequisite[],
  skipped: string[] = [],
): string {
  const [first] = orders;
  if (!first) {
    return '';
  }
  const total = orders.reduce((sum, order) => sum.plus(order.amountDue), new Prisma.Decimal(0));
  const title =
    first.orderNumber === first.baseNumber
      ? '💳 <b>Оплата на реквізити</b>'
      : '➕ <b>Оплата на реквізити · нова частина</b>';
  const ownRates = new Set(orders.map((order) => order.exchangeRate?.toFixed(4))).size > 1;
  const numbers =
    orders.length > 1
      ? orders.map((order) => {
          const rate =
            ownRates && order.exchangeRate ? ` · курс ${formatRate(order.exchangeRate)}` : '';
          return `№ <b>${escapeHtml(order.orderNumber)}</b> — ${money(order.amountDue, order.currency)}${rate}`;
        })
      : [`№ <b>${escapeHtml(first.orderNumber)}</b>`];
  return [
    title,
    ...numbers,
    orders.length > 1
      ? `Разом: ${money(total, first.currency)}`
      : `Сума: ${money(total, first.currency)}`,
    ...(first.exchangeRate && !ownRates ? [`Курс: ${formatRate(first.exchangeRate)}`] : []),
    ...(first.comment ? [`Коментар: ${escapeHtml(first.comment)}`] : []),
    ...(requisites.length > 0
      ? [
          '',
          'Реквізити:',
          ...requisites.flatMap((item, index) => [
            ...(index > 0 ? [''] : []),
            requisiteBlock(item.payerName, item.account, item.amount, first.currency, item.paidAt),
          ]),
        ]
      : []),
    ...(skipped.length > 0 ? [`Не додано (уже є в системі): ${skipped.join(', ')}`] : []),
    '',
    `Менеджер: ${escapeHtml(managerName)}`,
    `Створено: ${formatKyivDateTime(first.createdAt)}`,
  ].join('\n');
}
