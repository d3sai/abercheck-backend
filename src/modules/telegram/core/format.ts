import { kyivParts } from '../../../common/kyiv-time';
import { Currency, type Prisma } from '../../../generated/prisma/client';

export function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function formatMoney(value: Prisma.Decimal): string {
  const [integer = '0', fraction] = value.toFixed(2).split('.');
  const grouped = integer.replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  return fraction === '00' ? grouped : `${grouped},${fraction}`;
}

export function formatMoneyGrn(value: Prisma.Decimal): string {
  return `${formatMoney(value)} грн`;
}

export function formatMoneyIn(value: Prisma.Decimal, currency: Currency): string {
  return `${formatMoney(value)} ${currency === Currency.USD ? '$' : 'грн'}`;
}

export function formatKyivDateTime(date: Date): string {
  const p = kyivParts(date);
  return `${p.hour}:${p.minute} ${p.day}.${p.month}.${p.year}`;
}

export function formatKyivDate(date: Date): string {
  const p = kyivParts(date);
  return `${p.day}.${p.month}.${p.year}`;
}
