import { Currency, Prisma } from '../../../generated/prisma/client';
import { MONEY_PATTERN, MONEY_UNIT_SRC, UAH_UNIT_SRC, USD_UNIT_SRC } from '../../../common/money';
import { kyivDateTime, kyivParts } from '../../../common/kyiv-time';
import type { RequisiteInput } from '../../requisites/requisites.service';
import { formatMoneyIn } from '../core/format';
import { parseExchangeRate } from './order-draft.parsers';

export interface PlanItem {
  number: string;
  amount: Prisma.Decimal;
  note: string | null;
}

export type PlanKind = 'single' | 'group';

export interface RequisitesPlan {
  kind: PlanKind;
  /** One message is one payment: every amount in it is in this currency. */
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

export type RequisitesResult = { ok: true; plan: RequisitesPlan } | { ok: false; errors: string[] };

export const REQUISITES_MAX_LENGTH = 3000;
const COMMENT_MAX_LENGTH = 2000;

const ZERO = new Prisma.Decimal(0);

export const AMOUNT_SRC = String.raw`(?:\d{1,3}(?:[\u00a0\u202f ]\d{3})+|\d+)(?:[.,]\d{1,2})?`;
const AMOUNT = new RegExp(String.raw`(?<![\d.,:])(${AMOUNT_SRC})\s*${MONEY_UNIT_SRC}`, 'giu');
const TOTAL_LABEL = new RegExp(
  String.raw`^\s*(?:загальна\s+сума|разом|всього|сума)\s*[:\-–—]?\s*(${AMOUNT_SRC})\s*${MONEY_UNIT_SRC}?\s*$`,
  'iu',
);
const RATE_LABELED = /^\s*курс\s*[:\-–—]?\s*(\d{1,4}(?:[.,]\d{1,4})?)\s*%?\s*$/iu;
const RATE_LONE = /^\s*(\d{1,3}(?:[.,]\d{1,4})?)\s*(%?)\s*$/u;
const COMMENT_LABEL = /^\s*коментар\s*[:\-–—]\s*(.+?)\s*$/iu;
const DATE_ONLY = /^\s*\d{1,2}[./]\d{1,2}[./]\d{2,4}(?:\s+\d{1,2}:\d{2})?\s*$/u;
const NUMBER_AT_START = /^\s*(?:[№#]\s*)?(\d{4}-\d{6})(?!\d)(.*)$/u;
const NEAR_MISS_AT_START = /^\s*(?:[№#]\s*)?(\d{3}-\d{6})(?!\d)(.*)$/u;
const NUMBER_ANYWHERE = /(?<!\d)\d{4}-\d{6}(?!\d)/gu;
// A heading with nothing after its colon — "Зразок :", "Наприклад :", "Замовлення та сума в
// доларах :" — carries no data of its own.
export const LABEL_ONLY = /^[\p{L}\s'’]+:$/u;
export const CARD = /(?<!\d)(?:\d{4}[\u00a0 -]){3}\d{4}(?!\d)/u;
export const IBAN = /(?<![A-Za-z\d])UA\d{27}(?!\d)/u;
const DATE = /\d{1,2}[./]\d{1,2}[./]\d{2,4}/gu;
const TIME = /(?<!\d)\d{1,2}:\d{2}(?!\d)/gu;
const NOT_A_NAME = /^["“«]?(?:призначення|iban|ібан|єдрпоу|іпн|рнокпп|платіжна|ua\d)/iu;
const MARKERS = /(?<!\p{L})(?:iban|ібан|єдрпоу|рнокпп|іпн)(?!\p{L})/iu;
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
// Only a payment line says which account it went through, so only there is a number without
// "грн" taken for an amount — never in the ЄДРПОУ / ІПН / invoice lines copied around it.
const PAYMENT_LINE = /^\s*(?:фоп|тов)\s/iu;
const TRAILING_BARE_AMOUNT = new RegExp(String.raw`[\s\-–—:,;]*(?<![\d.,])${AMOUNT_SRC}$`, 'u');
const TRAILING_AMOUNT = new RegExp(String.raw`\p{L}[^\d]*?(?<![\d.,])(${AMOUNT_SRC})\s*$`, 'u');

// "$150" → "150 $": the amount readers below expect the unit after the number. Only a "$" glued
// to the digits counts (so "590 $ 10:50" keeps its unit), and one glued to a word or a URL is left
// alone.
export function unitAfterAmount(text: string): string {
  const prefixed = new RegExp(
    String.raw`(?<![\p{L}\p{N}/=?&#%_.~+-])\$(${AMOUNT_SRC})(?!\d)`,
    'gu',
  );
  return text.replace(prefixed, '$1 $$');
}

const UNIT_AFTER_DIGIT = new RegExp(String.raw`\d\s*(?:(${UAH_UNIT_SRC})|${USD_UNIT_SRC})`, 'giu');

export type CurrencyResult = { ok: true; currency: Currency } | { ok: false; error: string };

// One message is one payment, so all its amounts share a currency; no unit at all means hryvnias.
export function messageCurrency(text: string): CurrencyResult {
  let uah = false;
  let usd = false;
  for (const match of text.replace(/https?:\/\/\S+/giu, ' ').matchAll(UNIT_AFTER_DIGIT)) {
    if (match[1]) {
      uah = true;
    } else {
      usd = true;
    }
  }
  return uah && usd
    ? { ok: false, error: 'Гривні й долари в одному повідомленні — надішліть окремо.' }
    : { ok: true, currency: usd ? Currency.USD : Currency.UAH };
}

export function toDecimal(raw: string): Prisma.Decimal {
  return new Prisma.Decimal(raw.replace(/[\s\u00a0\u202f]/g, '').replace(',', '.'));
}

const amountRegex = (): RegExp => new RegExp(AMOUNT.source, 'iu');

export function firstAmount(text: string): Prisma.Decimal | null {
  const match = amountRegex().exec(text);
  return match ? toDecimal(match[1]!) : null;
}

function noteAfterAmount(text: string): string | null {
  const note = text
    .replace(amountRegex(), ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[\s\-–—:,;]+|[\s\-–—:,;]+$/g, '');
  return note === '' ? null : note;
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

// "5 вересня 2026" → "05.09.2026", so a date written in words reads like any other.
export function numericDates(text: string): string {
  return text.replace(WORD_DATE, (_, day: string, month: string, year: string) => {
    const index = MONTHS.indexOf(month.toLowerCase()) + 1;
    return `${day.padStart(2, '0')}.${String(index).padStart(2, '0')}.${year}`;
  });
}

// The amount of a payment line, with or without "грн": "5168 … Носенко Роман 2 287".
export function paymentAmount(line: string): Prisma.Decimal | null {
  const withCurrency = firstAmount(line);
  if (withCurrency || !(CARD.test(line) || PAYMENT_LINE.test(line))) {
    return withCurrency;
  }
  const bare = line
    .replace(new RegExp(CARD.source, 'gu'), ' ')
    .replace(new RegExp(IBAN.source, 'gu'), ' ')
    .replace(DATE, ' ')
    .replace(TIME, ' ')
    .replace(/[\s\-–—,;.]+$/u, '');
  const match = TRAILING_AMOUNT.exec(bare);
  return match ? toDecimal(match[1]!) : null;
}

export function hasMultipleOrdersOrRequisites(raw: string): boolean {
  const text = unitAfterAmount(raw);
  const lines = text.split(/\r?\n/);
  const numbers = new Set(text.match(NUMBER_ANYWHERE) ?? []);
  const amountLines = lines.filter((line) =>
    amountRegex().test(line.replace(NUMBER_ANYWHERE, ' ')),
  ).length;
  return (
    numbers.size > 1 || amountLines >= 2 || CARD.test(text) || IBAN.test(text) || MARKERS.test(text)
  );
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

type RestKind = 'blank' | 'date' | 'text';
export interface RestLine {
  text: string;
  kind: RestKind;
}

interface Scan {
  numbers: {
    number: string;
    amount: Prisma.Decimal | null;
    note: string | null;
    fixedFrom?: string;
  }[];
  other: Prisma.Decimal[];
  statedTotal: Prisma.Decimal | null;
  rate: string | null;
  comments: string[];
  rest: RestLine[];
  cardsWithoutAmount: string[];
  duplicates: string[];
}

// Just an amount (maybe with a note after it) — not a payer's line, which starts with a name.
function isBareAmountLine(trimmed: string): boolean {
  const at = amountRegex().exec(trimmed)?.index;
  return (
    at !== undefined &&
    !/\p{L}/u.test(trimmed.slice(0, at)) &&
    !NUMBER_AT_START.test(trimmed) &&
    !TOTAL_LABEL.test(trimmed) &&
    !RATE_LABELED.test(trimmed) &&
    !COMMENT_LABEL.test(trimmed) &&
    !CARD.test(trimmed) &&
    !IBAN.test(trimmed)
  );
}

function scan(lines: string[], allowNearMiss: boolean): Scan {
  const result: Scan = {
    numbers: [],
    other: [],
    statedTotal: null,
    rate: null,
    comments: [],
    rest: [],
    cardsWithoutAmount: [],
    duplicates: [],
  };

  const consumedByNumber = new Set<number>();

  for (let i = 0; i < lines.length; i += 1) {
    if (consumedByNumber.has(i)) {
      continue;
    }
    const line = lines[i]!;
    const trimmed = line.trim();
    if (trimmed === '') {
      result.rest.push({ text: '', kind: 'blank' });
      continue;
    }

    const comment = COMMENT_LABEL.exec(trimmed);
    if (comment) {
      result.comments.push(comment[1]!);
      continue;
    }
    const labeledRate = RATE_LABELED.exec(trimmed);
    if (labeledRate) {
      result.rate = labeledRate[1]!;
      continue;
    }
    const total = TOTAL_LABEL.exec(trimmed);
    if (total) {
      result.statedTotal = toDecimal(total[1]!);
      continue;
    }

    const exact = NUMBER_AT_START.exec(trimmed);
    const near = exact || !allowNearMiss ? null : NEAR_MISS_AT_START.exec(trimmed);
    const found = exact ?? near;
    if (found) {
      const number = near ? `0${found[1]!}` : found[1]!;
      let amount = firstAmount(found[2]!);
      let note = noteAfterAmount(found[2]!);
      if (!amount) {
        for (let j = i + 1; j < lines.length; j += 1) {
          const next = lines[j]!.trim();
          if (next === '') {
            continue;
          }
          if (isBareAmountLine(next)) {
            amount = firstAmount(next);
            note = noteAfterAmount(next);
            consumedByNumber.add(j);
          }
          break;
        }
      }
      if (result.numbers.some((item) => item.number === number)) {
        result.duplicates.push(number);
      } else {
        result.numbers.push({
          number,
          amount,
          note,
          ...(near ? { fixedFrom: found[1]! } : {}),
        });
      }
      continue;
    }

    const lone = loneRate(trimmed);
    if (lone !== null) {
      result.rate = lone;
      continue;
    }

    const amounts = [...trimmed.matchAll(AMOUNT)].map((match) => toDecimal(match[1]!));
    result.other.push(...amounts);
    if (amounts.length === 0 && CARD.test(trimmed) && !paymentAmount(trimmed)) {
      result.cardsWithoutAmount.push(trimmed.slice(0, 40));
    }
    const asDate = numericDates(trimmed);
    result.rest.push(
      DATE_ONLY.test(asDate)
        ? { text: asDate, kind: 'date' }
        : { text: line.replace(/\s+$/, ''), kind: 'text' },
    );
  }
  return result;
}

export function cleanName(line: string): string {
  return line
    .replace(AMOUNT, ' ')
    .replace(DATE, ' ')
    .replace(TIME, ' ')
    .replace(new RegExp(CARD.source, 'gu'), ' ')
    .replace(new RegExp(IBAN.source, 'gu'), ' ')
    .replace(/["“”«»]/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[\s\-–—:,.;()]+|[\s\-–—:,;()]+$/g, '');
}

function guessLabel(lines: string[]): string {
  for (const line of lines) {
    const trimmed = line.trim();
    if (
      trimmed === '' ||
      NOT_A_NAME.test(trimmed.replace(/^["“«\s]+/u, '')) ||
      NUMBER_AT_START.test(trimmed) ||
      TOTAL_LABEL.test(trimmed) ||
      RATE_LABELED.test(trimmed) ||
      COMMENT_LABEL.test(trimmed) ||
      loneRate(trimmed) !== null
    ) {
      continue;
    }
    const name = cleanName(trimmed);
    if (/\p{L}{3,}/u.test(name)) {
      return name.slice(0, 255);
    }
  }
  return 'Оплата на реквізити';
}

function buildComment(rest: RestLine[], comments: string[]): string | null {
  const parts: string[] = [];
  const dates = rest.filter((line) => line.kind === 'date');
  if (dates.length === 1) {
    parts.push(dates[0]!.text.trim());
  }
  parts.push(...comments);

  return parts.length > 0 ? parts.join(' · ').slice(0, COMMENT_MAX_LENGTH) : null;
}

// `fallback` dates a payment that has no date of its own nor a date line above it.
export function deriveRequisiteLines(rest: RestLine[], fallback?: Date): RequisiteInput[] {
  const lines = [...rest];
  const records: RequisiteInput[] = [];
  const seen: { nameWord: string; amount: string }[] = [];
  let currentDateText: string | null = null;

  const findAccount = (fromIndex: number): string | null => {
    for (const line of [lines[fromIndex]!, ...lines.slice(fromIndex + 1, fromIndex + 6)]) {
      if (line.kind === 'date') break;
      if (line !== lines[fromIndex] && line.kind === 'text' && amountRegex().test(line.text)) {
        break;
      }
      const match = CARD.exec(line.text) ?? IBAN.exec(line.text);
      if (match) return match[0];
      if (line.kind === 'blank') continue;
    }
    return null;
  };

  lines.forEach((line, index) => {
    if (line.kind === 'date') {
      currentDateText = line.text.trim();
      return;
    }
    if (line.kind !== 'text') {
      return;
    }
    const trimmed = line.text.trim();
    if (NOT_A_NAME.test(trimmed.replace(/^["“«\s]+/u, ''))) {
      return;
    }
    const amount = paymentAmount(trimmed);
    if (!amount) {
      return;
    }

    const ownDate = new RegExp(DATE.source, 'u').exec(trimmed)?.[0];
    const ownTime = new RegExp(TIME.source, 'u').exec(trimmed)?.[0];
    // A payment's own time wins over the time on the date line above it.
    const dateText =
      ownDate ?? (ownTime ? currentDateText?.replace(TIME, '').trim() : currentDateText);
    const whenText = [dateText, ownTime].filter(Boolean).join(' ');
    const paidAt = (whenText ? parseDateTime(whenText) : null) ?? fallback ?? new Date();

    const account = findAccount(index);
    const cleaned = cleanName(trimmed);
    const payerName =
      (firstAmount(trimmed) ? cleaned : cleaned.replace(TRAILING_BARE_AMOUNT, '')) || 'Не вказано';

    const nameWord = payerName.split(' ')[0]?.toLowerCase() ?? '';
    const amountKey = amount.toFixed(2);
    const isRestatement = seen.some(
      (s) =>
        s.amount === amountKey &&
        (payerName.toLowerCase().includes(s.nameWord) || s.nameWord === nameWord),
    );
    if (isRestatement) {
      return;
    }
    seen.push({ nameWord, amount: amountKey });
    records.push({
      payerName,
      account: account ?? null,
      amount: amountKey,
      paidAt,
    });
  });

  return records;
}

export const sum = (values: Prisma.Decimal[]): Prisma.Decimal =>
  values.reduce((total, value) => total.plus(value), ZERO);

export function parseRequisites(raw: string): RequisitesResult {
  if (raw.trim().length > REQUISITES_MAX_LENGTH) {
    return {
      ok: false,
      errors: [`Повідомлення задовге — максимум ${REQUISITES_MAX_LENGTH} символів.`],
    };
  }
  const text = unitAfterAmount(raw);
  const detected = messageCurrency(text);
  if (!detected.ok) {
    return { ok: false, errors: [detected.error] };
  }
  const { currency } = detected;
  const money = (value: Prisma.Decimal): string => formatMoneyIn(value, currency);

  const lines = text.split(/\r?\n/);
  const warnings: string[] = [];

  let found = scan(lines, false);
  if (found.numbers.length === 0) {
    const withFixes = scan(lines, true);
    if (withFixes.numbers.length > 0) {
      found = withFixes;
      for (const item of found.numbers) {
        if (item.fixedFrom) {
          warnings.push(
            `Номер «${item.fixedFrom}» схожий на ${item.number} — виправив, перевірте.`,
          );
        }
      }
    }
  }
  if (found.numbers.length === 0) {
    const anywhere = [...new Set(text.match(NUMBER_ANYWHERE) ?? [])];
    if (anywhere.length === 1) {
      found.numbers.push({ number: anywhere[0]!, amount: null, note: null });
      warnings.push(`Номер ${anywhere[0]!} знайдено не на початку рядка — перевірте.`);
    } else if (anywhere.length > 1) {
      return {
        ok: false,
        errors: [
          'Знайшов кілька номерів у тексті, але не на початку рядків. Напишіть кожен номер з нового рядка разом із сумою.',
        ],
      };
    } else {
      return {
        ok: false,
        errors: [
          'Немає номера. Якщо це мінус, натисніть «➖ Закрити мінус» (/newminus) і надішліть ще раз.',
        ],
      };
    }
  }

  const { numbers, other, statedTotal, rate } = found;
  const errors: string[] = [];
  for (const number of found.duplicates) {
    warnings.push(`Номер ${number} вказано кілька разів — врахував один раз.`);
  }
  for (const card of found.cardsWithoutAmount) {
    warnings.push(`У рядку з карткою «${card}» не знайшов суму.`);
  }

  const lineRecords = deriveRequisiteLines(found.rest);
  const lineTotal = sum(lineRecords.map((r) => new Prisma.Decimal(r.amount)));

  let kind: PlanKind;
  let items: PlanItem[] = [];
  let total: Prisma.Decimal | null = null;
  let derivedTotal = false;
  let requisiteLines: RequisiteInput[] = [];

  const mismatch = (
    ownLabel: string,
    own: Prisma.Decimal,
    otherLabel: string,
    other: Prisma.Decimal,
  ): void => {
    if (!own.equals(other)) {
      warnings.push(
        `${ownLabel} ${money(own)}, а ${otherLabel} ${money(other)} — різниця ${money(own.minus(other).abs())}.`,
      );
    }
  };

  if (numbers.length === 1) {
    kind = 'single';
    const own = numbers[0]!.amount;
    requisiteLines = lineRecords;
    if (statedTotal) {
      total = statedTotal;
      if (requisiteLines.length > 0) {
        mismatch('Сума рядків', lineTotal, 'загальна', statedTotal);
      } else if (own) {
        mismatch('Сума біля номера', own, 'загальна', statedTotal);
      }
    } else if (requisiteLines.length > 0) {
      total = lineTotal;
      derivedTotal = true;
      if (own && !own.equals(total)) {
        mismatch('Сума рядків', total, 'біля номера', own);
      }
    } else if (own) {
      total = own;
    }
    if (total) {
      items = [{ number: numbers[0]!.number, amount: total, note: numbers[0]!.note }];
    }
  } else {
    kind = 'group';
    for (const item of numbers) {
      if (!item.amount) {
        errors.push(
          `Біля номера ${item.number} немає суми — напишіть її зі словом «грн» (або знаком $) у тому ж рядку.`,
        );
      }
    }
    items = numbers.flatMap((item) =>
      item.amount ? [{ number: item.number, amount: item.amount, note: item.note }] : [],
    );
    total = sum(items.map((item) => item.amount));
    if (errors.length === 0) {
      if (statedTotal) {
        mismatch('Сума номерів', total, 'загальна', statedTotal);
      } else if (lineRecords.length > 0) {
        mismatch('Сума номерів', total, 'оплата', lineTotal);
      } else if (other.length > 0) {
        mismatch('Сума номерів', total, 'оплата', sum(other));
      }
    }
  }

  if (errors.length === 0 && total === null) {
    errors.push(
      'Не знайшов жодної суми. Пишіть суми зі словом «грн» (або знаком $) або додайте рядок «Загальна сума: 9 067 грн».',
    );
  }
  if (errors.length === 0 && total !== null) {
    const invalid = [total, ...items.map((item) => item.amount)].some(
      (amount) => !MONEY_PATTERN.test(amount.toFixed(2)),
    );
    if (invalid) {
      errors.push('Сума має бути додатною й не більшою за 12 цифр до коми.');
    }
  }
  if (errors.length > 0 || total === null) {
    return { ok: false, errors };
  }

  if (derivedTotal) {
    warnings.unshift('Загальної суми в тексті немає — я порахував її з рядків, перевірте.');
  }

  const label = guessLabel(lines);
  const normalizedRate = rate ? parseExchangeRate(rate) : null;
  const comment = buildComment(found.rest, found.comments);

  return {
    ok: true,
    plan: {
      kind,
      currency,
      items,
      total,
      derivedTotal,
      rate: normalizedRate?.ok ? normalizedRate.value : null,
      label,
      warnings,
      comment,
      // Numbers are the substance of a group, but a payment split across several third-party
      // accounts is still worth recording — e.g. several 1C numbers paid at once by two card
      // holders. lineRecords already excludes the numbers' own lines and the total.
      requisiteLines: kind === 'group' ? lineRecords : requisiteLines,
    },
  };
}

// The same message without the lines of the given numbers and without the total that covered them.
export function withoutNumbers(text: string, numbers: string[]): string {
  return text
    .split(/\r?\n/)
    .filter((line) => {
      const trimmed = line.trim();
      const found = NUMBER_AT_START.exec(trimmed);
      return !(found && numbers.includes(found[1]!)) && !TOTAL_LABEL.test(trimmed);
    })
    .join('\n');
}
