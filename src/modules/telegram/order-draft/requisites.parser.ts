import { Currency, Prisma } from '../../../generated/prisma/client';
import { kyivDateTime, kyivParts } from '../../../common/kyiv-time';
import type { RequisiteInput } from '../../requisites/requisites.service';

export interface PlanItem {
  number: string;
  amount: Prisma.Decimal;
  note: string | null;
  /** The note without remarks in brackets, e.g. «(залишок)»; only read for several numbers. */
  fop?: string | null;
  /** A rate of its own, from a «замовлення: … - по курсу 44» line; otherwise the plan's rate. */
  rate?: string | null;
}

export type PlanKind = 'single' | 'group';

export interface RequisitesPlan {
  kind: PlanKind;
  currency: Currency;
  items: PlanItem[];
  total: Prisma.Decimal;
  derivedTotal: boolean;
  rate: string | null;
  label: string;
  warnings: string[];
  comment: string | null;
  requisiteLines: RequisiteInput[];
}

export const REQUISITES_MAX_LENGTH = 3000;

const ZERO = new Prisma.Decimal(0);

export const AMOUNT_SRC = String.raw`(?:\d{1,3}(?:[\u00a0\u202f ]\d{3})+|\d+)(?:[.,]\d{1,2})?`;
const RATE_LONE = /^\s*(\d{1,3}(?:[.,]\d{1,4})?)\s*(%?)\s*$/u;
export const LABEL_ONLY = /^[\p{L}\s'’]+:$/u;
export const CARD = /(?<!\d)(?:(?:\d{4}[\u00a0 -]){3}\d{4}|\d{16})(?!\d)/u;
export const IBAN = /(?<![A-Za-z\d])UA\d{27}(?!\d)/u;
const DATETIME = /^(\d{1,2})[./](\d{1,2})[./](\d{4}|\d{2})(?:[ ,]+(\d{1,2}):(\d{2}))?$/;
const MONTHS = [
  'січня',
  'лютого',
  'березня',
  'квітня',
  'травня',
  'червня',
  'липня',
  'серпня',
  'вересня',
  'жовтня',
  'листопада',
  'грудня',
];
const WORD_DATE = new RegExp(
  String.raw`(?<!\d)(\d{1,2})\s+(${MONTHS.join('|')})\s+(\d{4})(?:\s*р(?:оку|\.)?)?`,
  'giu',
);

export function unitAfterAmount(text: string): string {
  const prefixed = new RegExp(
    String.raw`(?<![\p{L}\p{N}/=?&#%_.~+-])\$(${AMOUNT_SRC})(?!\d)`,
    'gu',
  );
  return text.replace(prefixed, '$1 $$');
}

export function toDecimal(raw: string): Prisma.Decimal {
  return new Prisma.Decimal(raw.replace(/[\s\u00a0\u202f]/g, '').replace(',', '.'));
}

export function parseDateTime(raw: string): Date | null {
  const match = DATETIME.exec(raw.trim());
  if (!match) {
    return null;
  }
  const day = Number(match[1]);
  const month = Number(match[2]);
  const year = match[3]!.length === 2 ? 2000 + Number(match[3]) : Number(match[3]);
  const hour = match[4] ? Number(match[4]) : 0;
  const minute = match[5] ? Number(match[5]) : 0;
  if (hour > 23 || minute > 59) {
    return null;
  }
  const date = kyivDateTime(year, month, day, hour, minute);
  const back = kyivParts(date);
  const roundTrips =
    Number(back.day) === day && Number(back.month) === month && Number(back.year) === year;
  return roundTrips ? date : null;
}

export function numericDates(text: string): string {
  return text.replace(WORD_DATE, (_, day: string, month: string, year: string) => {
    const index = MONTHS.indexOf(month.toLowerCase()) + 1;
    return `${day.padStart(2, '0')}.${String(index).padStart(2, '0')}.${year}`;
  });
}

export function loneRate(line: string): string | null {
  const match = RATE_LONE.exec(line);
  if (!match) {
    return null;
  }
  const value = Number(match[1]!.replace(',', '.'));
  const inRange = match[2] === '%' ? value >= 1 && value <= 500 : value >= 20 && value <= 200;
  return inRange ? match[1]! : null;
}

export const DATE_TIME_HINT = 'дату й час саме цього замовлення, у форматі ДД.ММ.РРРР ГГ:ХХ';

export const sum = (values: Prisma.Decimal[]): Prisma.Decimal =>
  values.reduce((total, value) => total.plus(value), ZERO);
