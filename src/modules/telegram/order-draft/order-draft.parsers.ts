import { MONEY_PATTERN, MONEY_UNIT_SRC, USD_UNIT_SRC } from '../../../common/money';
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

const USD_MARK = new RegExp(USD_UNIT_SRC, 'iu');

export function detectCurrency(input: string): Currency {
  return USD_MARK.test(input) ? Currency.USD : Currency.UAH;
}

export function parseMoney(input: string): ParseResult {
  const value = parseDecimal(input, new RegExp(MONEY_UNIT_SRC, 'giu'));
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
