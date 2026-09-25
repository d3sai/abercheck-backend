import type { Currency, Payment, Prisma } from '../../../generated/prisma/client';
import type { OrderWithManager, OrderWithPaid } from '../../orders/orders.service';
import { type BotReply, button } from '../core/bot-reply';
import { escapeHtml, formatKyivDate, formatMoney, formatMoneyIn } from '../core/format';
import { STATUS_LABELS } from './status-labels';

export const LIST_LIMIT = 20;
export const UNMATCHED_LIMIT = 10;

const shortDate = (date: Date) => formatKyivDate(date).slice(0, 5);
const clip = (text: string, max = 40) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

function balanceLine(
  amountDue: Prisma.Decimal,
  amountPaid: Prisma.Decimal,
  currency: Currency,
): string {
  const diff = amountDue.minus(amountPaid);
  const tail = diff.greaterThan(0)
    ? ` · залишок ${formatMoney(diff)}`
    : diff.lessThan(0)
      ? ` · переплата ${formatMoney(diff.negated())}`
      : '';
  return `${formatMoneyIn(amountDue, currency)} · сплачено ${formatMoney(amountPaid)}${tail}`;
}

function orderEntry(
  { order, amountPaid }: OrderWithPaid<OrderWithManager>,
  withManager: boolean,
): string {
  const head = [
    `${STATUS_LABELS[order.status].icon} <b>${escapeHtml(order.orderNumber)}</b>`,
    shortDate(order.createdAt),
    escapeHtml(clip(order.clientName)),
    ...(withManager ? [escapeHtml(clip(order.manager.name, 20))] : []),
  ].join(' · ');
  return `${head}\n${balanceLine(order.amountDue, amountPaid, order.currency)}`;
}

export interface OrderListInput {
  title: string;
  items: OrderWithPaid<OrderWithManager>[];
  total: number;
  withManager: boolean;
  unmatched?: { payments: Payment[]; total: number };
}

export function orderList({
  title,
  items,
  total,
  withManager,
  unmatched,
}: OrderListInput): BotReply {
  const shown = total > items.length ? ` · показано ${items.length} з ${total}` : ` · ${total}`;
  const sections = [
    `<b>${title}</b>${shown}`,
    items.length > 0
      ? items.map((item) => orderEntry(item, withManager)).join('\n\n')
      : 'Замовлень немає.',
  ];

  const buttons = [];
  if (unmatched && unmatched.total > 0) {
    const more =
      unmatched.total > unmatched.payments.length
        ? ` · показано ${unmatched.payments.length} з ${unmatched.total}`
        : ` · ${unmatched.total}`;
    sections.push(
      `<b>⚠️ Невідомі платежі</b>${more}`,
      unmatched.payments
        .map(
          (p) =>
            `#${p.id} · ${shortDate(p.paidAt)} · ${formatMoneyIn(p.amount, p.currency)} · ${escapeHtml(clip(p.payerName ?? '—'))}`,
        )
        .join('\n'),
    );
    buttons.push(
      ...unmatched.payments.map((p) => [button(`🔗 Прив'язати #${p.id}`, `attach:${p.id}`)]),
    );
  }

  return { html: sections.join('\n\n'), buttons: buttons.length > 0 ? buttons : undefined };
}
