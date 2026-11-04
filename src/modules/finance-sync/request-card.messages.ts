import { Prisma } from '../../generated/prisma/client';
import { type BotReply, button } from '../telegram/core/bot-reply';
import { escapeHtml, formatMoneyIn } from '../telegram/core/format';
import { formatRate } from '../telegram/notifications/order-templates';
import type {
  FinancePayoutView,
  FinanceFops,
  FinanceRequestView,
  RequestKind,
  RequestWarning,
} from './finance.types';

export const FinanceAction = {
  Fop: /^ff:([\w-]+):(\d+)$/,
  Rate: /^fr:([\w-]+)$/,
  Cancel: /^fc:([\w-]+)$/,
  Refresh: /^fu:([\w-]+)$/,
} as const;

const KIND_LABEL: Record<RequestKind, string> = {
  our_fop: 'Наш ФОП',
  foreign_fop: 'Чужий ФОП',
  card: 'На картку',
  minus: 'Закриття мінусу',
  dropship: 'Дропшипінг',
};

// `multi_order` is informational, so it has no line.
const WARNING_TEXT: Partial<Record<RequestWarning, string>> = {
  sum_mismatch: 'сума позицій не збігається із сумою запиту',
  iban_invalid: 'IBAN не проходить перевірку',
  card_invalid: 'номер картки не проходить перевірку',
};

const warningLines = (codes: RequestWarning[]): string[] =>
  codes.flatMap((code) => (WARNING_TEXT[code] ? [`⚠️ ${WARNING_TEXT[code]}`] : []));

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

function body(
  view: FinanceRequestView,
  pendingRate: string | null,
  managerName?: string,
): string[] {
  const kind = view.kind ? KIND_LABEL[view.kind] : 'Запит';
  const lines = [`<b>${kind}</b> #${escapeHtml(view.number)}`];
  if (managerName) lines.push(`Менеджер: ${escapeHtml(managerName)}`);
  for (const order of view.orders) {
    const own =
      order.exchangeRate && order.exchangeRate !== view.exchangeRate
        ? ` · курс ${rate(order.exchangeRate)}`
        : '';
    lines.push(`№ <b>${escapeHtml(order.orderNumber)}</b> — ${money(order.amount)}${own}`);
  }
  lines.push(`${view.orders.length > 1 ? 'Разом' : 'Сума'}: <b>${money(view.sum)}</b>`);
  if (pendingRate && view.status === 'pending') lines.push(`Курс: ${rate(pendingRate)} (нова)`);
  else if (view.exchangeRate) lines.push(`Курс: ${rate(view.exchangeRate)}`);
  if (view.clientLabel) lines.push(`Клієнт: ${escapeHtml(view.clientLabel)}`);
  if (view.sheetUrl) lines.push(`Таблиця: ${escapeHtml(view.sheetUrl)}`);
  if (view.officialDocs !== null) {
    lines.push(`Офіційні документи: ${view.officialDocs ? 'так' : 'ні'}`);
  }
  if (view.comment) lines.push(`Коментар: ${escapeHtml(view.comment)}`);

  const status: string[] = [];
  if (view.status === 'cancelled') status.push('❌ Скасовано');
  if (view.status === 'accepted') {
    status.push(
      `✅ Прийняв(ла): ${escapeHtml(view.responderName ?? '—')} · ФОП: ${escapeHtml(view.fopLabel ?? '—')}`,
      ...view.payouts.flatMap(payoutLines),
    );
  }
  if (view.isPaid) status.push('💰 Оплачено');
  const warnings = warningLines(view.warnings);
  return [...lines, ...(status.length > 0 ? ['', ...status] : []), ...warnings];
}

export function groupCard(
  view: FinanceRequestView,
  fops: FinanceFops | null,
  pendingRate: string | null,
  managerName?: string,
): BotReply {
  const lines = body(view, pendingRate, managerName);
  if (fops?.limitsStatus === 'unavailable') lines.push('', '⚠️ Залишки ФОП зараз недоступні');
  if (view.status !== 'pending') return { html: lines.join('\n') };

  const fopRows =
    fops && (view.kind === 'our_fop' || view.kind === 'minus')
      ? fops.fops.map((fop) => [
          button(
            `${fop.label} · ${fop.leftMonthWithReserve ? money(fop.leftMonthWithReserve) : '—'}`,
            `ff:${view.id}:${fop.fopId}`,
          ),
        ])
      : [];
  return {
    html: lines.join('\n'),
    buttons: [
      ...fopRows,
      [button('✏️ Інший курс', `fr:${view.id}`), button('🔄 Оновити', `fu:${view.id}`)],
    ],
  };
}

export function managerCard(view: FinanceRequestView): BotReply {
  const html = body(view, null).join('\n');
  return view.status === 'pending'
    ? { html, buttons: [[button('✖ Скасувати запит', `fc:${view.id}`)]] }
    : { html };
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
