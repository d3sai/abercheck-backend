import { MONEY_PATTERN } from '../../../common/money';
import { Prisma } from '../../../generated/prisma/client';
import { formatMoney } from '../core/format';
import { parseExchangeRate } from './order-draft.parsers';

// A payment made to other requisites (cards, other people's FOPs) is reported as one free-form
// message. Only the essentials are read out of it: 1C numbers, amounts ("<number> грн"), the total,
// the rate and a lone date. Everything else (cards, IBANs, names) stays a text the bot never
// interprets and shows back as the "Реквізити" section.

export interface PlanItem {
  number: string;
  amount: Prisma.Decimal;
  /** What was written after the amount on the number's line, e.g. "(залишок)". */
  note: string | null;
}

export type PlanKind = 'minus' | 'single' | 'group';

export interface RequisitesPlan {
  kind: PlanKind;
  /** Numbers with their own amounts: one for "single", several for "group", none for "minus". */
  items: PlanItem[];
  total: Prisma.Decimal;
  /** True when no total was written and the bot added the amounts up itself. */
  derivedTotal: boolean;
  /** The amounts the total is made of, in the order they were found. */
  amountLines: Prisma.Decimal[];
  rate: string | null;
  /** A short caption for lists. */
  label: string;
  warnings: string[];
  /** The message without the lines that were read out into fields: payment details as written. */
  requisites: string;
  /** A lone date, the header of a minus closing and a written "Коментар:" line. */
  comment: string | null;
}

export type RequisitesResult = { ok: true; plan: RequisitesPlan } | { ok: false; errors: string[] };

export const REQUISITES_MAX_LENGTH = 3000;
const COMMENT_MAX_LENGTH = 2000;

const ZERO = new Prisma.Decimal(0);

const AMOUNT_SRC = String.raw`(?:\d{1,3}(?:[\u00a0\u202f ]\d{3})+|\d+)(?:[.,]\d{1,2})?`;
// The look-behind keeps a time ("10:50 500 грн") or a date from being glued to the amount.
const AMOUNT = new RegExp(String.raw`(?<![\d.,:])(${AMOUNT_SRC})\s*грн\.?`, 'giu');
const TOTAL_LABEL = new RegExp(
  String.raw`^\s*(?:загальна\s+сума|разом|всього|сума)\s*[:\-–—]?\s*(${AMOUNT_SRC})\s*(?:грн\.?)?\s*$`,
  'iu',
);
const RATE_LABELED = /^\s*курс\s*[:\-–—]?\s*(\d{1,4}(?:[.,]\d{1,4})?)\s*%?\s*$/iu;
const RATE_LONE = /^\s*(\d{1,3}(?:[.,]\d{1,4})?)\s*(%?)\s*$/u;
const COMMENT_LABEL = /^\s*коментар\s*[:\-–—]\s*(.+?)\s*$/iu;
const DATE_ONLY = /^\s*\d{1,2}[./]\d{1,2}[./]\d{2,4}(?:\s+\d{1,2}:\d{2})?\s*$/u;
const NUMBER_AT_START = /^\s*(?:[№#]\s*)?(\d{4}-\d{6})(?!\d)(.*)$/u;
const NEAR_MISS_AT_START = /^\s*(?:[№#]\s*)?(\d{3}-\d{6})(?!\d)(.*)$/u;
const NUMBER_ANYWHERE = /(?<!\d)\d{4}-\d{6}(?!\d)/gu;
const CARD = /(?<!\d)(?:\d{4}[\u00a0 -]){3}\d{4}(?!\d)/u;
const IBAN = /(?<![A-Za-z\d])UA\d{27}(?!\d)/u;
const MARKERS = /(?<!\p{L})(?:iban|ібан|єдрпоу|рнокпп|іпн)(?!\p{L})/iu;
const DATE = /\d{1,2}[./]\d{1,2}[./]\d{2,4}/gu;
const TIME = /(?<!\d)\d{1,2}:\d{2}(?!\d)/gu;
const NOT_A_NAME = /^(?:призначення|iban|ібан|єдрпоу|іпн|рнокпп|платіжна|ua\d)/iu;

function toDecimal(raw: string): Prisma.Decimal {
  return new Prisma.Decimal(raw.replace(/[\s\u00a0\u202f]/g, '').replace(',', '.'));
}

const amountRegex = (): RegExp => new RegExp(AMOUNT.source, 'iu');

function firstAmount(text: string): Prisma.Decimal | null {
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

function loneRate(line: string): string | null {
  const match = RATE_LONE.exec(line);
  if (!match) {
    return null;
  }
  const value = Number(match[1]!.replace(',', '.'));
  const inRange = match[2] === '%' ? value >= 1 && value <= 500 : value >= 20 && value <= 200;
  return inRange ? match[1]! : null;
}

// Whether a message reads like a payment to other requisites rather than a regular order: several
// numbers, an IBAN or a card, or more than one amount. A labelled regular template never does.
export function looksLikeRequisites(text: string): boolean {
  const lines = text.split(/\r?\n/).map((line) => line.trim());
  const numberLines = lines.filter((line) => NUMBER_AT_START.test(line)).length;
  const amountLines = lines.filter((line) =>
    amountRegex().test(line.replace(NUMBER_ANYWHERE, ' ')),
  ).length;
  return (
    numberLines >= 2 || amountLines >= 2 || IBAN.test(text) || MARKERS.test(text) || CARD.test(text)
  );
}

interface RestLine {
  text: string;
  kind: 'blank' | 'date' | 'text';
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
  /** Lines nothing was read out of, in their order. */
  rest: RestLine[];
  cardsWithoutAmount: string[];
  duplicates: string[];
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

  for (const line of lines) {
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
      if (result.numbers.some((item) => item.number === number)) {
        result.duplicates.push(number);
      } else {
        result.numbers.push({
          number,
          amount: firstAmount(found[2]!),
          note: noteAfterAmount(found[2]!),
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
    if (amounts.length === 0 && CARD.test(trimmed)) {
      result.cardsWithoutAmount.push(trimmed.slice(0, 40));
    }
    result.rest.push({
      text: line.replace(/\s+$/, ''),
      kind: DATE_ONLY.test(trimmed) ? 'date' : 'text',
    });
  }
  return result;
}

function cleanName(line: string): string {
  return line
    .replace(AMOUNT, ' ')
    .replace(DATE, ' ')
    .replace(TIME, ' ')
    .replace(new RegExp(CARD.source, 'gu'), ' ')
    .replace(/["“”«»]/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[\s\-–—:,.;]+|[\s\-–—:,;]+$/g, '');
}

// A short caption for lists: the first line that reads like a name (a recipient, or the header of a
// minus closing); purely cosmetic, the full text is kept as it was written.
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
  return 'Оплата на інші реквізити';
}

// The header of a minus closing ("Закрила …", "Оплата мінусу клієнта …") is a description, not a
// payment detail.
function isHeader(text: string): boolean {
  const bare = text.trim().replace(/^["“«\s]+/u, '');
  return (
    text.trim().length <= 200 &&
    !NOT_A_NAME.test(bare) &&
    !amountRegex().test(text) &&
    !CARD.test(text) &&
    !IBAN.test(text) &&
    /\p{L}{3,}/u.test(text)
  );
}

function buildSections(
  found: Scan,
  kind: PlanKind,
): { requisites: string; comment: string | null } {
  let rest = [...found.rest];
  const parts: string[] = [];

  if (kind === 'minus') {
    const first = rest.find((line) => line.kind !== 'blank');
    if (first?.kind === 'text' && isHeader(first.text)) {
      parts.push(first.text.trim().replace(/[\s:]+$/, ''));
      rest = rest.filter((line) => line !== first);
    }
  }
  // One lone date is the payment date; several belong to their own payments and stay with them.
  const dates = rest.filter((line) => line.kind === 'date');
  if (dates.length === 1) {
    parts.push(dates[0]!.text.trim());
    rest = rest.filter((line) => line !== dates[0]);
  }
  parts.push(...found.comments);

  const requisites = rest
    .map((line) => line.text)
    .join('\n')
    .replace(/^\n+|\n+$/g, '')
    .replace(/\n{3,}/g, '\n\n');
  return {
    requisites,
    comment: parts.length > 0 ? parts.join(' · ').slice(0, COMMENT_MAX_LENGTH) : null,
  };
}

const sum = (values: Prisma.Decimal[]): Prisma.Decimal =>
  values.reduce((total, value) => total.plus(value), ZERO);

// The same amount can be written twice for one payment ("… 75 000 грн" and "виплата на … 75 000 грн"),
// so a sum is compared both with and without the repeats and the closer one is used.
function sumsOf(values: Prisma.Decimal[]): Prisma.Decimal[] {
  const distinct = values.filter(
    (value, index) => values.findIndex((other) => other.equals(value)) === index,
  );
  return [sum(values), sum(distinct)];
}

function closestTo(target: Prisma.Decimal, candidates: Prisma.Decimal[]): Prisma.Decimal {
  return candidates.reduce((best, candidate) =>
    candidate.minus(target).abs().lt(best.minus(target).abs()) ? candidate : best,
  );
}

const money = (value: Prisma.Decimal): string => `${formatMoney(value)} грн`;

export function parseRequisites(text: string): RequisitesResult {
  if (text.trim().length > REQUISITES_MAX_LENGTH) {
    return {
      ok: false,
      errors: [`Повідомлення задовге — максимум ${REQUISITES_MAX_LENGTH} символів.`],
    };
  }

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
    }
  }

  const { numbers, other, statedTotal, rate } = found;
  const errors: string[] = [];
  for (const number of found.duplicates) {
    warnings.push(`Номер ${number} вказано кілька разів — врахував один раз.`);
  }

  const repeated = other.filter(
    (amount, index) => other.findIndex((a) => a.equals(amount)) !== index,
  );
  for (const amount of new Set(repeated.map((a) => a.toFixed(2)))) {
    const times = other.filter((a) => a.toFixed(2) === amount).length;
    warnings.push(
      `Сума ${money(new Prisma.Decimal(amount))} зустрічається ${times} рази — це різні платежі?`,
    );
  }
  for (const card of found.cardsWithoutAmount) {
    warnings.push(`У рядку з карткою «${card}» не знайшов суму.`);
  }

  let kind: PlanKind;
  let items: PlanItem[] = [];
  let total: Prisma.Decimal | null = null;
  let derivedTotal = false;
  let amountLines: Prisma.Decimal[];

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

  if (numbers.length === 0) {
    kind = 'minus';
    amountLines = other;
    total = statedTotal ?? (other.length > 0 ? sum(other) : null);
    derivedTotal = statedTotal === null;
    if (statedTotal && other.length > 0) {
      mismatch('Сума рядків', closestTo(statedTotal, sumsOf(other)), 'загальна', statedTotal);
    }
  } else if (numbers.length === 1) {
    kind = 'single';
    const own = numbers[0]!.amount;
    if (statedTotal) {
      total = statedTotal;
      const built = other.length > 0 ? closestTo(statedTotal, sumsOf(other)) : own;
      if (built) {
        mismatch('Сума рядків', built, 'загальна', statedTotal);
      }
    } else if (other.length > 0) {
      total = sum(other);
      derivedTotal = true;
      if (own && !own.equals(total)) {
        mismatch('Сума рядків', total, 'біля номера', own);
      }
    } else if (own) {
      total = own;
    }
    amountLines = other.length > 0 ? other : own ? [own] : [];
    if (total) {
      items = [{ number: numbers[0]!.number, amount: total, note: numbers[0]!.note }];
    }
  } else {
    kind = 'group';
    for (const item of numbers) {
      if (!item.amount) {
        errors.push(
          `Біля номера ${item.number} немає суми — напишіть її зі словом «грн» у тому ж рядку.`,
        );
      }
    }
    items = numbers.flatMap((item) =>
      item.amount ? [{ number: item.number, amount: item.amount, note: item.note }] : [],
    );
    amountLines = items.map((item) => item.amount);
    total = sum(amountLines);
    if (errors.length === 0) {
      if (statedTotal) {
        mismatch('Сума номерів', total, 'загальна', statedTotal);
      } else if (other.length > 0) {
        mismatch('Сума номерів', total, 'оплата', closestTo(total, sumsOf(other)));
      }
    }
  }

  if (errors.length === 0 && total === null) {
    errors.push(
      'Не знайшов жодної суми. Пишіть суми зі словом «грн» або додайте рядок «Загальна сума: 9 067 грн».',
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

  let label = guessLabel(lines);
  if (kind === 'single' && other.length > 1) {
    label = `${label} +${other.length - 1}`.slice(0, 255);
  }

  const { requisites, comment } = buildSections(found, kind);
  const normalizedRate = rate ? parseExchangeRate(rate) : null;
  return {
    ok: true,
    plan: {
      kind,
      items,
      total,
      derivedTotal,
      amountLines,
      rate: normalizedRate?.ok ? normalizedRate.value : null,
      label,
      warnings,
      requisites,
      comment,
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
