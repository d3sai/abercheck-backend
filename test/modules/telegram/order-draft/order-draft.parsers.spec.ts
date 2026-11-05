import { Currency } from '../../../../src/generated/prisma/client';
import {
  detectCurrency,
  parseExchangeRate,
  parseMoney,
  parseOrderNumber,
} from '../../../../src/modules/telegram/order-draft/order-draft.parsers';

const value = (result: ReturnType<typeof parseMoney>) => (result.ok ? result.value : null);

describe('order draft parsers', () => {
  it.each([
    ['0000-066717', '0000-066717'],
    ['№А 0000-066717', '0000-066717'],
    ['1548', null],
    ['0000-06671', null],
  ])('parseOrderNumber(%p) → %p', (input, expected) => {
    expect(value(parseOrderNumber(input))).toBe(expected);
  });

  it('should point out a number that is one digit short instead of fixing it', () => {
    expect(parseOrderNumber('000-066717')).toEqual({
      ok: false,
      error: 'Бракує цифри. Може, 0000-066717?',
    });
  });

  it.each([
    ['6 158,41 грн', '6158.41'],
    ['6158.41', '6158.41'],
    ['17675', '17675'],
    ['1 197,2', '1197.2'],
    ['4\u00a0594.45 грн.', '4594.45'],
    ['17 933,31 ГРН', '17933.31'],
    ['6.158,41', null],
    ['0', null],
    ['-100', null],
    ['12,345', null],
    ['сто', null],
    ['150 $', '150'],
    ['$150', '150'],
    ['1 250,50$', '1250.50'],
    ['150 USD', '150'],
    ['150usd', '150'],
    ['150 дол.', '150'],
    ['150 доларів', '150'],
    ['$', null],
  ])('parseMoney(%p) → %p', (input, expected) => {
    expect(value(parseMoney(input))).toBe(expected);
  });

  it.each([
    ['6 158,41 грн', Currency.UAH],
    ['6158.41', Currency.UAH],
    ['150 $', Currency.USD],
    ['$150', Currency.USD],
    ['150 usd', Currency.USD],
    ['150 дол.', Currency.USD],
    ['150 Доларів', Currency.USD],
  ])('detectCurrency(%p) → %p', (input, expected) => {
    expect(detectCurrency(input)).toBe(expected);
  });

  it.each([
    ['44,9', '44.9'],
    ['44,9%', '44.9'],
    ['44.95 %', '44.95'],
    ['0', null],
    ['44,12345', null],
  ])('parseExchangeRate(%p) → %p', (input, expected) => {
    expect(value(parseExchangeRate(input))).toBe(expected);
  });
});
