import { kyivParts } from '../../common/kyiv-time';
import { Prisma } from '../../generated/prisma/client';
import { type BotReply, button } from '../telegram/core/bot-reply';
import { escapeHtml, formatMoneyIn } from '../telegram/core/format';
import { formatRate } from '../telegram/notifications/order-templates';
import {
  type FinanceFop,
  type FinancePayoutView,
  type FinanceFops,
  type FinanceRequestView,
  paysAfterConfirm,
  type RequestKind,
  type RequestWarning,
} from './finance.types';
import type { StoredPayment } from './stored-payments';

export const FinanceAction = {
  Fop: /^ff:([\w-]+):(\d+)$/,
  Cancel: /^fc:([\w-]+)$/,
  Refresh: /^fu:([\w-]+)$/,
  /** «✅ Прийняти» on the manager card: create the orders from the stored payments. */
  Accept: /^mo:([\w-]+)$/,
  /** «📎 Прикріпити файли»: the bot asks for the files as a reply; they go straight to Telegram. */
  Attach: /^ma:([\w-]+)$/,
  /** «Запит #N» under «До якого запиту додати файл?» for a file sent straight into the chat. */
  Route: /^mr:([\w-]+)$/,
} as const;

const attachButton = (id: string) => button('📎 Прикріпити файли', `ma:${id}`);
const ATTACH_HINT = '📎 Квитанція: просто надішліть фото чи файл у цей чат.';

const KIND_LABEL: Record<RequestKind, string> = {
  our_fop: 'Наш ФОП',
  foreign_fop: 'Чужий ФОП',
  card: 'На картку',
  minus: 'Закриття мінусу',
};

// `multi_order` is informational, so it has no line.
const WARNING_TEXT: Partial<Record<RequestWarning, string>> = {
  sum_mismatch: 'сума позицій не збігається із сумою запиту',
  iban_invalid: 'IBAN не проходить перевірку',
  card_invalid: 'номер картки не проходить перевірку',
};

const warningLines = (codes: RequestWarning[]): string[] =>
  codes.flatMap((code) => (WARNING_TEXT[code] ? [`⚠️ ${WARNING_TEXT[code]}`] : []));

const plural = (count: number): string =>
  count % 10 === 1 && count % 100 !== 11
    ? 'замовлення'
    : count % 10 >= 2 && count % 10 <= 4 && (count % 100 < 12 || count % 100 > 14)
      ? 'замовлення'
      : 'замовлень';

const money = (value: string): string => formatMoneyIn(new Prisma.Decimal(value), 'UAH');
const rate = (value: string): string => formatRate(new Prisma.Decimal(value));

function payoutLines(payout: FinancePayoutView): string[] {
  const parts = [
    payout.recipientName,
    payout.iban,
    payout.taxId && `ІПН ${payout.taxId}`,
    payout.purpose,
    payout.amount && money(payout.amount),
  ].filter((part): part is string => Boolean(part));
  return [`• ${parts.map(escapeHtml).join(' · ')}`, ...warningLines(payout.warnings)];
}

// Telegram refuses a message over 4096 chars; the headroom is for what the callers add after the body
const MAX_BODY = 3500;
const MAX_COMMENT = 300;

/** Whole payouts that fit the budget; «…» marks the rest. */
function fitPayouts(payouts: string[][], budget: number): string[] {
  const shown: string[] = [];
  let used = 0;
  for (const lines of payouts) {
    const size = lines.join('\n').length + 1;
    if (used + size > budget - 2) return [...shown, '…'];
    shown.push(...lines);
    used += size;
  }
  return shown;
}

interface BodyOptions {
  managerName?: string;
  /** Lines shown after the request's status and before the warnings; they count against the budget. */
  extra?: string[];
  /** Every order shows its own rate, not only those that differ from the request's. */
  allRates?: boolean;
}

function body(
  view: FinanceRequestView,
  { managerName, extra = [], allRates }: BodyOptions = {},
): string[] {
  const kind = view.kind ? KIND_LABEL[view.kind] : 'Запит';
  const lines = [`<b>${kind}</b> #${escapeHtml(view.number)}`];
  if (managerName) lines.push(`Менеджер: ${escapeHtml(managerName)}`);
  for (const order of view.orders) {
    const own =
      order.exchangeRate && (allRates || order.exchangeRate !== view.exchangeRate)
        ? ` · курс ${rate(order.exchangeRate)}`
        : '';
    lines.push(`№ <b>${escapeHtml(order.orderNumber)}</b> — ${money(order.amount)}${own}`);
  }
  lines.push(`${view.orders.length > 1 ? 'Разом' : 'Сума'}: <b>${money(view.sum)}</b>`);
  if (view.exchangeRate) lines.push(`Курс: ${rate(view.exchangeRate)}`);
  if (view.clientLabel) lines.push(`Клієнт: ${escapeHtml(view.clientLabel)}`);
  if (view.sheetUrl) lines.push(`Таблиця: ${escapeHtml(view.sheetUrl)}`);
  if (view.kind === 'our_fop' && view.officialDocs !== null) {
    lines.push(`Офіційні документи: ${view.officialDocs ? 'так' : 'ні'}`);
  }
  if (view.comment) {
    const chars = [...view.comment];
    const comment =
      chars.length > MAX_COMMENT ? `${chars.slice(0, MAX_COMMENT).join('')}…` : view.comment;
    lines.push(`Коментар: ${escapeHtml(comment)}`);
  }

  const warnings = warningLines(view.warnings);
  const assemble = (payouts: string[]): string[] => {
    const status: string[] = [];
    if (view.status === 'cancelled') status.push('❌ Скасовано');
    if (view.status === 'accepted') {
      status.push(
        `✅ Прийняв(ла): ${escapeHtml(view.responderName ?? '—')} · ФОП: ${escapeHtml(view.fopLabel ?? '—')}`,
        ...payouts,
      );
    }
    if (view.isPaid) status.push('💰 Оплачено');
    return [
      ...lines,
      ...(status.length > 0 ? ['', ...status] : []),
      ...(extra.length > 0 ? ['', ...extra] : []),
      ...warnings,
    ];
  };
  const fixed = assemble([]).join('\n').length;
  return assemble(fitPayouts(view.payouts.map(payoutLines), MAX_BODY - fixed));
}

// a FOP whose limit cannot take the sum is noise; it can still be named in a «ФОП …» reply
const fits = (fop: FinanceFop, sum: string, fops: FinanceFops): boolean =>
  fops.limitsStatus === 'unavailable' ||
  fop.leftMonthWithReserve === null ||
  new Prisma.Decimal(fop.leftMonthWithReserve).gte(sum);

export function groupCard(
  view: FinanceRequestView,
  fops: FinanceFops | null,
  managerName?: string,
): BotReply {
  const lines = body(view, { managerName });
  const picksFop = view.status === 'pending' && (view.kind === 'our_fop' || view.kind === 'minus');
  const fopRows =
    fops && picksFop
      ? fops.fops
          .filter((fop) => fits(fop, view.sum, fops))
          .map((fop) => [
            button(
              `${fop.label} · ${fop.leftMonthWithReserve ? money(fop.leftMonthWithReserve) : '—'}`,
              `ff:${view.id}:${fop.fopId}`,
            ),
          ])
      : [];
  // a pending card without FOP buttons must say why, or the financier sees a dead card
  if (fops?.limitsStatus === 'unavailable' || (picksFop && !fops)) {
    lines.push('', '⚠️ Залишки ФОП зараз недоступні');
  } else if (picksFop && fopRows.length === 0) {
    lines.push('', '⚠️ Жоден ФОП не вміщує суму — відповідайте «ФОП …»');
  }
  if (view.status !== 'pending') return { html: lines.join('\n') };

  return {
    html: lines.join('\n'),
    buttons: [...fopRows, [button('🔄 Оновити', `fu:${view.id}`)]],
  };
}

export interface ManagerCardOptions {
  /** Set when the Mini App is configured; its buttons are private-chat-only, so never on the group card. */
  miniAppUrl?: string;
  /** The payments stored at creation: part of the ready text the manager accepts. */
  payments?: StoredPayment[];
  /** The card's real state: set once the manager completed the request. */
  completed?: { orderNumbers: string[]; closed?: boolean; paidAt?: Date | null } | false;
}

const webApp = (text: string, miniAppUrl: string, mode: string, id: string) => {
  const url = new URL(miniAppUrl);
  url.searchParams.set('mode', mode);
  url.searchParams.set('id', id);
  return { text, web_app: { url: url.toString() } };
};

const completedLine = (orderNumbers: string[]): string => {
  const count = orderNumbers.length;
  if (count === 0) return '✅ Оформлено';
  return `✅ Оформлено: № ${escapeHtml(orderNumbers.join(', '))}${count > 1 ? ` (${count} ${plural(count)})` : ''}`;
};

/** dd.mm.yyyy hh:mm, Kyiv time */
const dateTime = (date: Date): string => {
  const p = kyivParts(date);
  return `${p.day}.${p.month}.${p.year} ${p.hour}:${p.minute}`;
};

// the 4096 minus MAX_BODY leaves room for the lines the body does not count
const PAYMENTS_BUDGET = 500;
const MAX_PAYMENT_PART = 100;

const clip = (text: string): string => {
  const chars = [...text];
  return chars.length > MAX_PAYMENT_PART ? `${chars.slice(0, MAX_PAYMENT_PART).join('')}…` : text;
};

function paymentLine(payment: StoredPayment): string {
  const parts = [
    payment.payerName && clip(payment.payerName),
    payment.account && clip(payment.account),
    money(payment.amount),
    payment.paidAt && dateTime(new Date(payment.paidAt)),
  ].filter((part): part is string => Boolean(part));
  return `• ${parts.map(escapeHtml).join(' · ')}`;
}

/** The payments the orders will get; whole lines within the budget, «…» for the rest. */
function paymentLines(kind: RequestKind | null, payments: StoredPayment[]): string[] {
  if (payments.length === 0) return paysAfterConfirm(kind) ? ['Платіж: клієнт ще не оплатив'] : [];
  const lines = ['<b>Платежі:</b>'];
  let used = lines[0]!.length;
  for (const payment of payments) {
    const line = paymentLine(payment);
    if (used + line.length + 1 > PAYMENTS_BUDGET - 2) return [...lines, '…'];
    lines.push(line);
    used += line.length + 1;
  }
  return lines;
}

export function managerCard(view: FinanceRequestView, opts: ManagerCardOptions = {}): BotReply {
  const { miniAppUrl, completed, payments = [] } = opts;
  if (completed) {
    const lines = [...body(view), '', completedLine(completed.orderNumbers)];
    lines.push(ATTACH_HINT);
    const paysLater = paysAfterConfirm(view.kind);
    if (paysLater && completed.closed) {
      lines.push(
        completed.paidAt ? `✅ Оплачено ${dateTime(completed.paidAt)} · закрито` : '✅ Закрито',
      );
    }
    const paid =
      miniAppUrl && paysLater && !completed.closed
        ? [webApp('💰 Оплачено', miniAppUrl, 'paid', view.id)]
        : [];
    return { html: lines.join('\n'), buttons: [[...paid, attachButton(view.id)]] };
  }
  // no editing: a manager accepts or cancels; a change is a new request
  if (view.status === 'pending') {
    return {
      html: body(view).join('\n'),
      buttons: [[button('✖ Скасувати запит', `fc:${view.id}`)]],
    };
  }
  if (view.status !== 'accepted') return { html: body(view).join('\n') };

  // accepted: the ready text. A request without stored payments (older cards) cannot be accepted
  // as it stands, except our_fop and foreign_fop, whose client has not paid yet.
  const ready = paysAfterConfirm(view.kind) || payments.length > 0;
  const html = [
    ...body(view, { extra: paymentLines(view.kind, payments), allRates: true }),
    '',
    ATTACH_HINT,
  ].join('\n');
  const row = [
    ...(ready
      ? [button('✅ Прийняти', `mo:${view.id}`)]
      : miniAppUrl
        ? [webApp('📎 Додати дату', miniAppUrl, 'complete', view.id)]
        : []),
    button('✖ Скасувати', `fc:${view.id}`),
  ];
  return { html, buttons: [...(row.length > 0 ? [row] : []), [attachButton(view.id)]] };
}

/** Alert text for a failed accept; `status` is only needed for 403. Telegram caps alerts at 200 chars. */
export function acceptRefusal(
  code: string,
  details?: Record<string, unknown>,
  status?: number,
): string {
  if (status === 403 || code === 'http-403') return 'Відповідати може лише фінансист';
  const project = typeof details?.project === 'string' ? details.project : '';
  const text =
    {
      'fop-limit-exceeded': 'Сума перевищує залишок цього ФОП',
      'fop-foreign-project': `ФОП іншого проєкту (${project})`,
      'manager-project-unassigned': 'Менеджеру не призначено проєкт',
      'fop-limits-unavailable': 'Не вдалося перевірити ліміти, спробуйте ще раз',
      'already-accepted': 'Цей запит уже прийнято',
      'payouts-unrecognized': 'Не розпізнав реквізити',
    }[code] ??
    (status !== undefined && status >= 400 && status < 500
      ? `Фінанси відхилили запит (${code})`
      : 'Фінанси не відповіли, спробуйте ще раз');
  return text.slice(0, 200);
}
