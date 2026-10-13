import { EUR_UNIT_SRC, MONEY_PATTERN, UAH_UNIT_SRC, USD_UNIT_SRC } from '../../../common/money';
import { Currency, type Prisma } from '../../../generated/prisma/client';
import { parseExchangeRate, parseOrderNumber } from './order-draft.parsers';
import {
  AMOUNT_SRC,
  DATE_TIME_HINT,
  LABEL_ONLY,
  REQUISITES_MAX_LENGTH,
  numericDates,
  parseDateTime,
  toDecimal,
  unitAfterAmount,
} from './requisites.parser';

export interface ForeignPlan {
  number: string;
  amount: Prisma.Decimal;
  currency: Currency;
  recipient: string | null;
  rate: string | null;
  paidAt: Date | null;
  comment: string | null;
  warnings: string[];
}

export type ForeignResult = { ok: true; plan: ForeignPlan } | { ok: false; errors: string[] };

type Label = 'recipient' | 'number' | 'amount' | 'currency' | 'date' | 'rate' | 'comment';

const HEADER = /^оплата\s+закордонного\s+замовлення\s*[:\-–—]?\s*$/iu;
const LABELS: [Label, RegExp][] = [
  ['recipient', /^на\s+кого(?!\p{L})\s*[:\-–—]?\s*(.*)$/iu],
  ['number', /^(?:№|#|замовлення|номер)(?!\p{L})\s*[:\-–—]?\s*(.*)$/iu],
  ['amount', /^сума(?!\p{L})\s*[:\-–—]?\s*(.*)$/iu],
  ['currency', /^валюта(?!\p{L})\s*[:\-–—]?\s*(.*)$/iu],
  ['date', /^дата(?:\s+(?:та|і)\s+час)?(?!\p{L})\s*[:\-–—]?\s*(.*)$/iu],
  ['rate', /^курс(?!\p{L})\s*[:\-–—]?\s*(.*)$/iu],
  ['comment', /^коментар(?!\p{L})\s*[:\-–—]?\s*(.*)$/iu],
];
// The template puts an emoji before some labels («💰 Сума»).
const LEADING_SYMBOLS = /^[^\p{L}\p{N}№#]+/u;
const AMOUNT_LINE = new RegExp(String.raw`^(${AMOUNT_SRC})\s*(.*)$`, 'u');
const CURRENCY_UNITS: [Currency, RegExp][] = [
  [Currency.UAH, new RegExp(String.raw`^(?:${UAH_UNIT_SRC}|uah(?!\p{L})|гривн\p{L}*)$`, 'iu')],
  [Currency.USD, new RegExp(`^${USD_UNIT_SRC}$`, 'iu')],
  [Currency.EUR, new RegExp(`^${EUR_UNIT_SRC}$`, 'iu')],
];
const CURRENCY_HINT = 'Напишіть UAH, USD або EUR: «Сума: 100 EUR» чи «Валюта: EUR».';

const currencyOf = (text: string): Currency | null =>
  CURRENCY_UNITS.find(([, re]) => re.test(text))?.[0] ?? null;
// The template pasted outside /foreign: its header or the «На кого:» label.
const FOREIGN_SHAPE = /^[^\p{L}\p{N}]*(?:оплата\s+закордонного\s+замовлення|на\s+кого\s*:)/imu;

export const isForeignTemplate = (text: string): boolean => FOREIGN_SHAPE.test(text);

export function parseForeign(raw: string): ForeignResult {
  if (raw.trim().length > REQUISITES_MAX_LENGTH) {
    return {
      ok: false,
      errors: [`Повідомлення задовге, максимум ${REQUISITES_MAX_LENGTH} символів.`],
    };
  }
  const fields: Partial<Record<Exclude<Label, 'comment'>, string>> = {};
  const comments: string[] = [];

  for (const original of raw.split(/\r?\n/)) {
    const line = original.replace(LEADING_SYMBOLS, '').replace(/\s+/g, ' ').trim();
    if (line === '' || HEADER.test(line) || LABEL_ONLY.test(line)) {
      continue;
    }
    const labeled = LABELS.map(([label, re]) => [label, re.exec(line)?.[1]?.trim()] as const).find(
      ([, value]) => value !== undefined,
    );
    if (!labeled) {
      comments.push(line);
      continue;
    }
    const [label, value] = labeled;
    if (!value) continue;
    if (label === 'comment') comments.push(value);
    else fields[label] = value;
  }

  const errors: string[] = [];
  const warnings: string[] = [];

  let number: string | null = null;
  if (fields.number === undefined) {
    errors.push('Не знайшов номер замовлення. Формат: 0000-066498.');
  } else {
    const parsed = parseOrderNumber(fields.number);
    if (parsed.ok) number = parsed.value;
    else errors.push(`Номер «${fields.number}»: ${parsed.error}`);
  }

  const amount = fields.amount ? AMOUNT_LINE.exec(unitAfterAmount(fields.amount)) : null;
  if (!fields.amount) {
    errors.push('Не знайшов суму. Наприклад: 100 EUR.');
  } else if (!amount) {
    errors.push(`Не розібрав суму «${fields.amount}».`);
  } else if (!MONEY_PATTERN.test(toDecimal(amount[1]!).toFixed(2))) {
    errors.push('Сума має бути більшою за нуль.');
  }

  // The unit after the amount and the «Валюта» line may each name the currency; they must agree.
  const unit = amount?.[2]?.trim() ?? '';
  const unitCurrency = unit === '' ? null : currencyOf(unit);
  const labelCurrency = fields.currency ? currencyOf(fields.currency) : null;
  if (unit !== '' && !unitCurrency) {
    errors.push(`Не розібрав валюту «${unit}». ${CURRENCY_HINT}`);
  }
  if (fields.currency && !labelCurrency) {
    errors.push(`Не розібрав валюту «${fields.currency}». ${CURRENCY_HINT}`);
  }
  if (unitCurrency && labelCurrency && unitCurrency !== labelCurrency) {
    errors.push('У «Сума» і «Валюта» різні валюти.');
  }
  const currency = unitCurrency ?? labelCurrency;
  if (!currency && unit === '' && !fields.currency) {
    errors.push(`Не вказано валюту. ${CURRENCY_HINT}`);
  }

  const paidAt = fields.date ? parseDateTime(numericDates(fields.date)) : null;
  if (!fields.date || !/\d:\d{2}/.test(fields.date)) {
    errors.push(`Не вказано дату й час. Напишіть ${DATE_TIME_HINT}.`);
  } else if (!paidAt) {
    errors.push(`Не розібрав дату «${fields.date}». Напишіть ${DATE_TIME_HINT}.`);
  }

  let rate: string | null = null;
  if (fields.rate) {
    const parsed = parseExchangeRate(fields.rate);
    if (parsed.ok) rate = parsed.value;
    else warnings.push(`Не розібрав курс «${fields.rate}».`);
  }
  if (!fields.recipient) {
    warnings.push('Не вказано, на кого.');
  }

  if (errors.length > 0 || number === null || !amount || currency === null) {
    return { ok: false, errors };
  }
  return {
    ok: true,
    plan: {
      number,
      amount: toDecimal(amount[1]!),
      currency,
      recipient: fields.recipient ? fields.recipient.slice(0, 255) : null,
      rate,
      paidAt,
      comment: comments.length > 0 ? comments.join(' · ').slice(0, 1000) : null,
      warnings,
    },
  };
}
