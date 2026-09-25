import { MONEY_PATTERN } from '../../../common/money';
import { Currency } from '../../../generated/prisma/client';
import { EXCHANGE_RATE_PATTERN } from '../../orders/dto/create-order.dto';
import { normalizeOrderNumber } from '../../orders/order-number';

export type ParseResult = { ok: true; value: string } | { ok: false; error: string };

const ok = (value: string): ParseResult => ({ ok: true, value });
const fail = (error: string): ParseResult => ({ ok: false, error });

export function parseOrderNumber(input: string): ParseResult {
  const value = normalizeOrderNumber(input);
  if (/^\d{4}-\d{6}$/.test(value)) {
    return ok(value);
  }
  // No preview here — the order is created at once — so a likely typo is pointed out, never fixed.
  return /^\d{3}-\d{6}$/.test(value)
    ? fail(`Бракує цифри. Може, 0${value}?`)
    : fail('Номер має бути у форматі 0000-066717.');
}

function parseDecimal(input: string, suffix: RegExp): string | null {
  const compact = input.replace(suffix, '').replace(/[\s\u00a0\u202f]/g, '');
  if (compact.includes(',') && compact.includes('.')) {
    return null;
  }
  return compact.replace(',', '.');
}

const USD_MARK = /\$|usd|дол(?:ар\p{L}*)?\.?/iu;

// "150 $", "$150", "150 usd", "150 дол." — anything without a dollar mark is hryvnias.
export function detectCurrency(input: string): Currency {
  return USD_MARK.test(input) ? Currency.USD : Currency.UAH;
}

export function parseMoney(input: string): ParseResult {
  const value = parseDecimal(input, new RegExp(`грн\\.?|${USD_MARK.source}`, 'giu'));
  return value !== null && MONEY_PATTERN.test(value)
    ? ok(value)
    : fail('Вкажіть суму числом, до копійок: 6 158,41');
}

export function parseExchangeRate(input: string): ParseResult {
  const value = parseDecimal(input, /%/g);
  return value !== null && EXCHANGE_RATE_PATTERN.test(value)
    ? ok(value)
    : fail('Вкажіть курс числом: 44,9');
}

export function parseText(maxLength: number): (input: string) => ParseResult {
  return (input) => {
    const value = input.trim();
    if (value.length === 0) {
      return fail('Значення не може бути порожнім.');
    }
    return value.length <= maxLength ? ok(value) : fail(`Не більше ${maxLength} символів.`);
  };
}

export interface TemplateField {
  field: string;
  label: string;
}

export function parseTemplate(
  text: string,
  fields: readonly TemplateField[],
): Record<string, string> {
  const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const labelPattern = fields.map((f) => escapeRegExp(f.label)).join('|');
  const re = new RegExp(`^[ \\t]*(${labelPattern})[ \\t]*:[ \\t]*`, 'gim');
  const matches = [...text.matchAll(re)];

  const result: Record<string, string> = {};
  matches.forEach((match, index) => {
    const field = fields.find((f) => f.label.toLowerCase() === match[1]!.toLowerCase())?.field;
    if (!field) {
      return;
    }
    const start = match.index + match[0].length;
    const end = index + 1 < matches.length ? matches[index + 1]!.index : text.length;
    result[field] = text.slice(start, end).trim();
  });
  return result;
}

const ORDER_NUMBER_SHAPE = /^[№#]?\s*\d[\d\s]*-\s*\d[\d\s]*$/;

export function parseFreeform(text: string): Record<string, string> | null {
  const lines = text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  const amountIndex = lines.findIndex((line) => parseMoney(line).ok);
  if (amountIndex === -1) {
    return null;
  }

  const result: Record<string, string> = {};
  let nameStart = 0;
  if (amountIndex > 0 && ORDER_NUMBER_SHAPE.test(lines[0]!)) {
    result.orderNumber = lines[0]!;
    nameStart = 1;
  }

  result.clientName = lines.slice(nameStart, amountIndex).join(' ').trim();
  result.amountDue = lines[amountIndex]!;

  const rest = lines.slice(amountIndex + 1);
  let commentStart = 0;
  if (rest.length > 0 && parseExchangeRate(rest[0]!).ok) {
    result.exchangeRate = rest[0]!;
    commentStart = 1;
  }
  if (commentStart < rest.length) {
    result.comment = rest.slice(commentStart).join('\n');
  }

  return result;
}
