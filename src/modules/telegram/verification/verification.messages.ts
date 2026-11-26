import type { InlineKeyboardButton } from 'telegraf/types';
import type { Currency, Order, Prisma } from '../../../generated/prisma/client';
import { button } from '../core/bot-reply';
import { escapeHtml, formatKyivDate, formatKyivDateTime, formatMoneyIn } from '../core/format';

export const PROBLEMS = {
  date: 'Немає дати',
  time: 'Немає часу',
  payee: 'Не вказано, на кого',
  processing: 'Квитанція в обробці',
  sum: 'Сума не збігається',
  receipt: 'Немає квитанції',
  sheet: 'Немає посилання на таблицю',
  period: 'Немає періоду підрахунку',
  requisites: 'Немає реквізитів чи номера картки',
  cash: 'Не вказано, хто кому передав готівку',
} as const;

export type ProblemCode = keyof typeof PROBLEMS;

const CODES = Object.keys(PROBLEMS) as ProblemCode[];

export const problemsOf = (raw: string | null): ProblemCode[] =>
  CODES.filter((code) => raw?.split(',').includes(code));

export const maskOf = (codes: ProblemCode[]): number =>
  codes.reduce((mask, code) => mask | (1 << CODES.indexOf(code)), 0);

export const codesOf = (mask: number): ProblemCode[] =>
  CODES.filter((_, index) => mask & (1 << index));

const textOf = (codes: ProblemCode[]): string =>
  codes.map((code) => lower(PROBLEMS[code])).join('; ');

export const VerifyAction = {
  Ok: /^vf:ok:(\d+)$/,
  Bad: /^vf:bad:(\d+)$/,
  Reason: /^vf:r:(\d+):(\d+)$/,
  Send: /^vf:s:(\d+):(\d+)$/,
  Undo: /^vf:undo:(\d+)$/,
  Back: /^vf:back:(\d+)$/,
} as const;

export interface VerifyState {
  id: number;
  verifiedAt: Date | null;
  verifiedByName: string | null;
  problem: string | null;
  problemAt: Date | null;
  problemByName: string | null;
}

export interface DigestItem {
  orderNumber: string;
  clientName: string;
  amountDue: Prisma.Decimal;
  currency: Currency;
  managerName: string;
  createdAt: Date;
  problems: ProblemCode[];
  verifyMessageId: number;
}

const MESSAGE_LIMIT = 4096;
const CLIENT_LIMIT = 40;

const lower = (text: string): string => text.charAt(0).toLowerCase() + text.slice(1);
const stamp = (name: string | null, at: Date | null): string =>
  [name, at && formatKyivDateTime(at)].filter(Boolean).join(' · ');

export function verifyButtons(state: VerifyState): InlineKeyboardButton[][] {
  const verify = button('✅ Звірено', `vf:ok:${state.id}`);
  if (state.verifiedAt) {
    return [
      [
        button(
          `✅ Звірено · ${stamp(state.verifiedByName, state.verifiedAt)}`,
          `vf:undo:${state.id}`,
        ),
      ],
    ];
  }
  const problems = problemsOf(state.problem);
  if (problems.length > 0) {
    const label = problems.length === 1 ? PROBLEMS[problems[0]!] : `Проблем: ${problems.length}`;
    return [
      [
        button(
          `⚠️ ${label} · ${stamp(state.problemByName, state.problemAt)}`,
          `vf:bad:${state.id}`,
        ),
      ],
      [verify],
    ];
  }
  return [[verify, button('⚠️ Проблема', `vf:bad:${state.id}`)]];
}

export function reasonButtons(orderId: number, mask: number): InlineKeyboardButton[][] {
  const reasons = CODES.map((code, index) =>
    button(
      `${mask & (1 << index) ? '✅ ' : ''}${PROBLEMS[code]}`,
      `vf:r:${orderId}:${mask ^ (1 << index)}`,
    ),
  );
  const rows: InlineKeyboardButton[][] = [];
  for (let index = 0; index < reasons.length; index += 2)
    rows.push(reasons.slice(index, index + 2));
  const send =
    mask === 0
      ? []
      : [[button(`📨 Надіслати (${codesOf(mask).length})`, `vf:s:${orderId}:${mask}`)]];
  return [...rows, ...send, [button('↩️ Назад', `vf:back:${orderId}`)]];
}

export const controlsMessage = (orderNumbers: string[]): string =>
  `🔎 Звірка № ${escapeHtml(orderNumbers.join(', '))}`;

export function problemNotice(
  order: Pick<Order, 'orderNumber' | 'clientName' | 'amountDue' | 'currency'>,
  codes: ProblemCode[],
): string {
  return `⚠️ Фінансист: № ${escapeHtml(order.orderNumber)} (${escapeHtml(order.clientName)}, ${formatMoneyIn(order.amountDue, order.currency)}): ${textOf(codes)}`;
}

function digestLine(item: DigestItem, chatPath: string): string {
  const client = [...item.clientName];
  const parts = [
    `<a href="https://t.me/c/${chatPath}/${item.verifyMessageId}">№ ${escapeHtml(item.orderNumber)}</a>`,
    escapeHtml(
      client.length > CLIENT_LIMIT ? `${client.slice(0, CLIENT_LIMIT).join('')}…` : item.clientName,
    ),
    formatMoneyIn(item.amountDue, item.currency),
    ...(item.problems.length > 0 ? [textOf(item.problems)] : []),
    escapeHtml(item.managerName),
    formatKyivDate(item.createdAt),
  ];
  return `• ${parts.join(' · ')}`;
}

export function digestMessage(items: DigestItem[], chatId: number): string | null {
  if (items.length === 0) return null;
  const chatPath = String(chatId).replace(/^-100/, '');
  const problems = items.filter((item) => item.problems.length > 0);
  const unverified = items.filter((item) => item.problems.length === 0);
  const sections: [string, DigestItem[]][] = [
    [`⚠️ Проблеми: ${problems.length}`, problems],
    [`🕓 Незвірені: ${unverified.length}`, unverified],
  ];

  const reserve = `\n…ще ${items.length}`.length;
  const lines = ['🔎 <b>Звірка</b>'];
  let length = lines[0]!.length;
  let shown = 0;
  for (const [title, group] of sections) {
    if (group.length === 0) continue;
    for (const line of ['', title, ...group.map((item) => digestLine(item, chatPath))]) {
      if (length + line.length + 1 + reserve > MESSAGE_LIMIT) {
        return [...lines, `…ще ${items.length - shown}`].join('\n');
      }
      lines.push(line);
      length += line.length + 1;
      if (line.startsWith('• ')) shown += 1;
    }
  }
  return lines.join('\n');
}
