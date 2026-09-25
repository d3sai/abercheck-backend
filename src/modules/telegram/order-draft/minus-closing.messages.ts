import {
  type Currency,
  type Order,
  type OrderRequisite,
  Prisma,
} from '../../../generated/prisma/client';
import { MAX_FILES_PER_UPLOAD } from '../../attachments/attachments.constants';
import { type BotReply, button } from '../core/bot-reply';
import { escapeHtml, formatKyivDateTime, formatMoneyIn as money } from '../core/format';
import { formatRate } from '../notifications/order-templates';
import type { MinusPlan } from './minus-closing.parser';
import { requisiteBlock } from './requisites.messages';

export const MinusAction = {
  Send: 'minus:ok',
  Edit: 'minus:edit',
} as const;

interface ClosingView {
  /** Only once created — the preview has no number yet. */
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

// The "Закриття заборгованості клієнта" template itself: the preview and the admins' notice read
// exactly like the template the business uses.
function closingLines(view: ClosingView): string[] {
  const period = view.period ? ` ${escapeHtml(view.period)}` : '';
  const received = [
    ...(view.ourFop ? [`Наш ФОП: ${escapeHtml(view.ourFop)}`] : []),
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

export function minusHint(): BotReply {
  const example = [
    'Клієнт: Гук Руслан за підрахунком 31.08.2026',
    'Дата: 05.09.2026 12:36',
    'Сума: 27 409 грн',
    'Отримано на: ФОП Берчатов М. М.',
    'Коментар: з урахуванням 1%',
    'Курс: 44,9',
    'Таблиця: https://docs.google.com/…',
  ].join('\n');
  return {
    html: [
      '➖ <b>Закриття мінусу</b>',
      'Надішліть одним повідомленням.',
      'Оплата на картку чи чужий ФОП: кожен платіж окремим рядком, наприклад:',
      '',
      `<pre>${escapeHtml(example)}</pre>`,
      'Суми в доларах пишіть зі знаком $ — усі суми в повідомленні в одній валюті.',
      '',
      `Файли (до ${MAX_FILES_PER_UPLOAD}) додавайте разом із текстом або перед ним.`,
    ].join('\n'),
  };
}

export function minusPreview(plan: MinusPlan, files: number): BotReply {
  const lines = [
    ...closingLines({
      ...plan,
      requisites: plan.requisiteLines.map((r) => ({ ...r, amount: new Prisma.Decimal(r.amount) })),
      rate: plan.rate ? new Prisma.Decimal(plan.rate) : null,
    }),
    ...(files > 0 ? ['', `Файлів: ${files}`] : []),
    ...(plan.warnings.length > 0 ? ['', ...plan.warnings.map((w) => `⚠️ ${escapeHtml(w)}`)] : []),
  ];
  return {
    html: lines.join('\n'),
    buttons: [[button('✅ Надіслати', MinusAction.Send), button('✏️ Виправити', MinusAction.Edit)]],
  };
}

export function minusCreatedReply(order: Order): BotReply {
  return {
    html: [
      `➖ Закриття мінусу № <b>${escapeHtml(order.orderNumber)}</b> створено · ${money(order.amountDue, order.currency)}`,
      escapeHtml(order.clientName),
    ].join('\n'),
  };
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
