import { Prisma } from '../../../../src/generated/prisma/client';
import {
  escapeHtml,
  formatKyivDate,
  formatKyivDateTime,
  formatMoney,
  formatMoneyIn,
} from '../../../../src/modules/telegram/core/format';

describe('formatMoney', () => {
  it.each([
    ['6158.41', '6 158,41'],
    ['17675', '17 675'],
    ['1197.2', '1 197,20'],
    ['0', '0'],
    ['50', '50'],
    ['999999999999.99', '999 999 999 999,99'],
    ['-50', '-50'],
  ])('should format %s as %s', (value, expected) => {
    expect(formatMoney(new Prisma.Decimal(value))).toBe(expected);
  });
});

describe('formatMoneyIn', () => {
  it.each([
    ['UAH', '6 158,41 грн'],
    ['USD', '6 158,41 $'],
    ['EUR', '6 158,41 €'],
  ] as const)('should format %s as %s', (currency, expected) => {
    expect(formatMoneyIn(new Prisma.Decimal('6158.41'), currency)).toBe(expected);
  });
});

describe('Kyiv date formatting', () => {
  it('should convert UTC to Kyiv summer time', () => {
    const date = new Date('2026-09-03T12:00:00Z');

    expect(formatKyivDateTime(date)).toBe('15:00 03.09.2026');
    expect(formatKyivDate(date)).toBe('03.09.2026');
  });

  it('should handle winter time and the date change after midnight', () => {
    expect(formatKyivDateTime(new Date('2026-12-31T22:30:00Z'))).toBe('00:30 01.01.2027');
  });
});

describe('escapeHtml', () => {
  it('should escape characters that break Telegram HTML', () => {
    expect(escapeHtml('ТОВ "A&B" <b>')).toBe('ТОВ "A&amp;B" &lt;b&gt;');
  });
});
