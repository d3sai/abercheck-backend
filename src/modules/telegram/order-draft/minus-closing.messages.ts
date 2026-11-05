import {
  type Currency,
  type Order,
  type OrderRequisite,
  Prisma,
} from '../../../generated/prisma/client';
import { escapeHtml, formatKyivDateTime, formatMoneyIn as money } from '../core/format';
import { formatRate } from '../notifications/order-templates';
import { requisiteBlock } from './requisites.messages';

interface ClosingView {
  orderNumber?: string;
  clientName: string;
  period: string | null;
  paidAt: Date | null;
  currency: Currency;
  total: Prisma.Decimal;
  ourFop: string | null;
  requisites: { payerName: string; account: string | null; amount: Prisma.Decimal; paidAt: Date }[];
  comment: string | null;
  rate: Prisma.Decimal | null;
  sheetUrl: string | null;
}

function closingLines(view: ClosingView): string[] {
  const period = view.period ? ` ${escapeHtml(view.period)}` : '';
  const received = [
    ...(view.ourFop
      ? [`${/^тов\s/iu.test(view.ourFop) ? 'Отримано на' : 'Наш ФОП'}: ${escapeHtml(view.ourFop)}`]
      : []),
    ...view.requisites.map((r) =>
      requisiteBlock(r.payerName, r.account, r.amount, view.currency, r.paidAt),
    ),
  ];
  return [
    '➖ <b>Закриття заборгованості клієнта</b>',
    ...(view.orderNumber ? [`№ <b>${escapeHtml(view.orderNumber)}</b>`] : []),
    `Клієнт: <b>${escapeHtml(view.clientName)}</b>${period}`,
    `Дата: ${view.paidAt ? formatKyivDateTime(view.paidAt) : '—'}`,
    `Загальна сума: <b>${money(view.total, view.currency)}</b>`,
    `Оплату отримано на:${received.length > 0 ? '' : ' —'}`,
    ...received.flatMap((line) => ['', line]),
    ...(view.comment ? ['', `Коментар: ${escapeHtml(view.comment)}`] : []),
    ...(view.rate || view.sheetUrl ? [''] : []),
    ...(view.rate ? [`Курс: ${formatRate(view.rate)}`] : []),
    ...(view.sheetUrl ? [`Посилання на таблицю: ${escapeHtml(view.sheetUrl)}`] : []),
  ];
}

export function adminMinusMessage(
  order: Order,
  managerName: string,
  requisites: OrderRequisite[],
): string {
  return [
    ...closingLines({
      ...order,
      total: order.amountDue,
      requisites,
      rate: order.exchangeRate,
    }),
    '',
    `Менеджер: ${escapeHtml(managerName)}`,
    `Створено: ${formatKyivDateTime(order.createdAt)}`,
  ].join('\n');
}
