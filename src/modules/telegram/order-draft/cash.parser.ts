import type { Currency, Prisma } from '../../../generated/prisma/client';
import { MONEY_PATTERN, MONEY_UNIT_SRC } from '../../../common/money';
import { detectCurrency, parseExchangeRate, parseOrderNumber } from './order-draft.parsers';
import {
  AMOUNT_SRC,
  LABEL_ONLY,
  REQUISITES_MAX_LENGTH,
  numericDates,
  parseDateTime,
  toDecimal,
  unitAfterAmount,
} from './requisites.parser';

// "Оплата готівкою": a manager took cash for one 1C number, in hryvnias or dollars.
export interface CashPlan {
  number: string;
  amount: Prisma.Decimal;
  currency: Currency;
  rate: string | null;
  paidAt: Date | null;
  handedBy: string | null;
  warnings: string[];
}

export type CashResult = { ok: true; plan: CashPlan } | { ok: false; errors: string[] };

type Label = 'number' | 'date' | 'amount' | 'rate' | 'handedBy';

const HEADER = /^оплата\s+готівкою\s*[:\-–—]?\s*$/iu;
const LABELS: [Label, RegExp][] = [
  ['number', /^(?:замовлення|номер)(?!\p{L})\s*[:\-–—]?\s*(.*)$/iu],
  ['date', /^дата(?:\s+(?:та|і)\s+час)?(?!\p{L})\s*[:\-–—]?\s*(.*)$/iu],
  ['amount', /^сума(?!\p{L})\s*[:\-–—]?\s*(.*)$/iu],
  ['rate', /^курс(?!\p{L})\s*[:\-–—]?\s*(.*)$/iu],
  ['handedBy', /^(?:ким\s+)?передан[оа](?!\p{L})\s*[:\-–—]?\s*(.*)$/iu],
];
const NUMBER_LINE = /^[№#]?\s*(\d{3,4}\s*-\s*\d{6})$/u;
const AMOUNT_LINE = new RegExp(String.raw`^(${AMOUNT_SRC})\s*(${MONEY_UNIT_SRC})?$`, 'iu');

export function parseCash(raw: string): CashResult {
  if (raw.trim().length > REQUISITES_MAX_LENGTH) {
    return {
      ok: false,
      errors: [`Повідомлення задовге, максимум ${REQUISITES_MAX_LENGTH} символів.`],
    };
  }
  let number: string | null = null;
  let amountLine: string | null = null;
  let rate: string | null = null;
  let date: string | null = null;
  const handedBy: string[] = [];
  const errors: string[] = [];
  const warnings: string[] = [];

  const takeNumber = (value: string): void => {
    const parsed = parseOrderNumber(value);
    if (parsed.ok) number = parsed.value;
    else errors.push(`Номер «${value}»: ${parsed.error}`);
  };
  const takeRate = (value: string): void => {
    const parsed = parseExchangeRate(value);
    if (parsed.ok) rate = parsed.value;
    else warnings.push(`Не розібрав курс «${value}».`);
  };

  for (const original of unitAfterAmount(raw).split(/\r?\n/)) {
    const line = original.replace(/\s+/g, ' ').trim();
    if (line === '' || HEADER.test(line) || LABEL_ONLY.test(line)) {
      continue;
    }
    const labeled = LABELS.map(([label, re]) => [label, re.exec(line)?.[1]?.trim()] as const).find(
      ([, value]) => value !== undefined,
    );
    if (labeled) {
      const [label, value] = labeled;
      if (!value) continue;
      if (label === 'number') takeNumber(value);
      if (label === 'date') date = value;
      if (label === 'amount') amountLine = value;
      if (label === 'rate') takeRate(value);
      if (label === 'handedBy') handedBy.push(value);
      continue;
    }
    // The same fields without labels, one per line, as managers usually write them.
    if (NUMBER_LINE.test(line)) {
      takeNumber(line);
    } else if (parseDateTime(numericDates(line))) {
      date = line;
    } else if (AMOUNT_LINE.test(line) && amountLine === null) {
      amountLine = line;
    } else if (AMOUNT_LINE.test(line) && rate === null) {
      takeRate(line);
    } else {
      handedBy.push(line);
    }
  }

  const amount = amountLine ? AMOUNT_LINE.exec(amountLine) : null;
  if (number === null && errors.length === 0) {
    errors.push('Не знайшов номер замовлення. Формат: 0000-066498.');
  }
  if (!amount) {
    errors.push(
      amountLine ? `Не розібрав суму «${amountLine}».` : 'Не знайшов суму. Наприклад: 4260 грн.',
    );
  } else if (!MONEY_PATTERN.test(toDecimal(amount[1]!).toFixed(2))) {
    errors.push('Сума має бути більшою за нуль.');
  }
  if (errors.length > 0 || number === null || !amount) {
    return { ok: false, errors };
  }

  const paidAt = date ? parseDateTime(numericDates(date)) : null;
  if (!date) {
    warnings.push('Не вказано дату.');
  } else if (!paidAt) {
    warnings.push(`Не розібрав дату «${date}». Формат: 01.09.2026 15:20.`);
  }
  if (handedBy.length === 0) {
    warnings.push('Не вказано, ким передано.');
  }

  return {
    ok: true,
    plan: {
      number,
      amount: toDecimal(amount[1]!),
      currency: detectCurrency(amountLine!),
      rate,
      paidAt,
      handedBy: handedBy.length > 0 ? handedBy.join(' ').slice(0, 255) : null,
      warnings,
    },
  };
}

// Same message twice means the same payment: the number, time and amount identify it.
export function cashPaymentId(plan: CashPlan): string {
  return `cash:${plan.number}:${plan.paidAt?.toISOString() ?? 'no-date'}:${plan.amount.toFixed(2)}`;
}
