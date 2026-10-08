import { MONEY_PATTERN, MONEY_UNIT_SRC } from '../../../common/money';
import { Currency, Prisma } from '../../../generated/prisma/client';
import type { RequisiteInput } from '../../requisites/requisites.service';
import { formatMoneyIn } from '../core/format';
import { parseExchangeRate } from './order-draft.parsers';
import {
  AMOUNT_SRC,
  CARD,
  DATE_TIME_HINT,
  IBAN,
  REQUISITES_MAX_LENGTH,
  type RestLine,
  cleanName,
  deriveRequisiteLines,
  loneRate,
  messageCurrency,
  numericDates,
  parseDateTime,
  paymentAmount,
  sum,
  toDecimal,
  unitAfterAmount,
} from './requisites.parser';

export interface MinusPlan {
  clientName: string;
  period: string | null;
  paidAt: Date | null;
  currency: Currency;
  total: Prisma.Decimal;
  ourFop: string | null;
  requisiteLines: RequisiteInput[];
  comment: string | null;
  rate: string | null;
  sheetUrl: string | null;
  warnings: string[];
}

export type MinusResult = { ok: true; plan: MinusPlan } | { ok: false; errors: string[] };

type Label =
  'name' | 'date' | 'total' | 'receivedOn' | 'ourFop' | 'ourCompany' | 'comment' | 'rate' | 'sheet';

const LABELS: [Label, RegExp][] = [
  ['name', /^(?:піб(?:\s*\(\s*фоп\s*\))?|клієнт|(?:фоп|тов)(?=\s*:))/iu],
  ['date', /^дата/iu],
  ['total', /^(?:загальна\s+)?сума/iu],
  ['receivedOn', /^(?:оплату\s+)?отримано\s+на/iu],
  ['ourFop', /^наш\s+фоп/iu],
  ['ourCompany', /^наше\s+тов|^наш\s+тов/iu],
  ['comment', /^коментар/iu],
  ['rate', /^курс/iu],
  ['sheet', /^(?:посилання(?:\s+на\s+таблицю)?|таблиця)/iu],
];
const LABEL_VALUE = /^(?:\s*[:\-–—]\s*|\s+)(.*)$/u;

const HEADER =
  /^(?:(?:закриття|оплата)\s+(?:мінусу|заборгованості)(?:\s+клієнта)?|закри(?:ла|в|ли)(?:\s+мінус)?)(?:\s*[:\-–—])?\s*(.*)$/iu;
const BANK_NOISE = /\d|призначення|iban|ібан|єдрпоу|рнокпп|іпн|платіжна/iu;
const PERIOD = /\s+(за\s+(?:підрахунком|період|\d).*)$/iu;
const URL_PATTERN = /https?:\/\/\S+/iu;
const NUMBER_ONLY = /^[№#]?\s*(\d{4}-\d{6})$/u;
const TIME_IN_DATE = /\d:\d{2}$/u;
const FOP_PREFIX = /^фоп\s+/iu;
const COMPANY_PREFIX = /^тов\s+/iu;
const ON_CARD = /^(?:на\s+)?(?:карт[ауиі]|картку|рахунок)\s+/iu;
const DATE_LINE =
  /^(\d{1,2}[./]\d{1,2}[./](?:\d{4}|\d{2}))(?:[ ,]+(\d{1,2})\s*[.:]{1,2}\s*(\d{2}))?$/u;
const LEADING_AMOUNT = new RegExp(String.raw`^(${AMOUNT_SRC})(?:\s*${MONEY_UNIT_SRC})?`, 'iu');
const AMOUNT_WITH_UNIT = new RegExp(
  String.raw`(?<![\d.,:])(${AMOUNT_SRC})\s*${MONEY_UNIT_SRC}`,
  'iu',
);

const trimPunctuation = (text: string): string => text.replace(/^[\s:\-–—,]+|[\s:\-–—,.]+$/gu, '');
const unwrap = (text: string): string => text.replace(/^\((.*)\)$/u, '$1').trim();

function matchLabel(line: string): { label: Label; value: string } | null {
  for (const [label, re] of LABELS) {
    const head = re.exec(line);
    const value = head ? LABEL_VALUE.exec(line.slice(head[0].length)) : null;
    if (value) {
      return { label, value: value[1]!.trim() };
    }
  }
  return null;
}

function normalizeDate(line: string): string | null {
  const match = DATE_LINE.exec(numericDates(line));
  if (!match) {
    return null;
  }
  return match[2] ? `${match[1]} ${match[2]}:${match[3]}` : match[1]!;
}

function bareAmount(line: string): { amount: Prisma.Decimal; note: string } | null {
  const match = AMOUNT_WITH_UNIT.exec(line);
  if (!match || /[\p{L}\d]/u.test(line.slice(0, match.index))) {
    return null;
  }
  return {
    amount: toDecimal(match[1]!),
    note: unwrap(trimPunctuation(line.slice(match.index + match[0].length))),
  };
}

function splitPeriod(text: string): { name: string; period: string | null } {
  const match = PERIOD.exec(text);
  const name = trimPunctuation(match ? text.slice(0, match.index) : text);
  return { name, period: match ? trimPunctuation(match[1]!) : null };
}

export function parseMinusClosing(raw: string): MinusResult {
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

  const found: {
    name: string | null;
    date: string | null;
    total: Prisma.Decimal | null;
    ourFop: string | null;
    rate: string | null;
    sheetUrl: string | null;
  } = { name: null, date: null, total: null, ourFop: null, rate: null, sheetUrl: null };
  const comments: string[] = [];
  const rest: RestLine[] = [];
  const warnings: string[] = [];

  const takeDate = (raw: string): void => {
    const normalized = normalizeDate(raw);
    if (!normalized) {
      warnings.push(`Не розібрав дату «${raw}». Напишіть ${DATE_TIME_HINT}.`);
      return;
    }
    found.date ??= normalized;
    rest.push({ text: normalized, kind: 'date' });
  };
  const takeTotal = (raw: string): void => {
    const match = LEADING_AMOUNT.exec(raw);
    if (!match) {
      warnings.push(`Не розібрав суму «${raw}».`);
      return;
    }
    found.total = toDecimal(match[1]!);
    const note = unwrap(trimPunctuation(raw.slice(match[0].length)));
    if (note) comments.push(note);
  };
  const takeRate = (raw: string): boolean => {
    const parsed = parseExchangeRate(raw);
    if (parsed.ok) found.rate = parsed.value;
    return parsed.ok;
  };
  const takeOurFop = (raw: string): void => {
    found.ourFop ??= raw.replace(FOP_PREFIX, '').trim().slice(0, 255);
  };
  // A company keeps its «ТОВ» in the name, a FOP drops the «ФОП» word.
  const takeOurCompany = (raw: string): void => {
    takeOurFop(COMPANY_PREFIX.test(raw) ? raw : `ТОВ ${raw}`);
  };

  let previous = '';
  for (const original of text.split(/\r?\n/)) {
    const url = URL_PATTERN.exec(original)?.[0];
    if (url) {
      found.sheetUrl ??= url;
    }
    const line = (url ? original.replace(url, ' ') : original).replace(/\s+/g, ' ').trim();
    if (line === '') {
      rest.push({ text: '', kind: 'blank' });
      continue;
    }
    const before = previous;
    previous = line;

    const header = HEADER.exec(line);
    if (header) {
      if (header[1]) found.name ??= header[1];
      continue;
    }

    const labeled = matchLabel(line);
    if (labeled) {
      const { label, value } = labeled;
      if (value === '') continue;
      switch (label) {
        case 'name':
          found.name = value;
          break;
        case 'date':
          takeDate(value);
          break;
        case 'total':
          takeTotal(value);
          break;
        case 'ourFop':
          takeOurFop(value);
          break;
        case 'ourCompany':
          takeOurCompany(value);
          break;
        case 'receivedOn':
          if (paymentAmount(value) || CARD.test(value) || IBAN.test(value)) {
            rest.push({ text: value, kind: 'text' });
          } else {
            takeOurFop(value.replace(/^наш\s+/iu, ''));
          }
          break;
        case 'comment':
          comments.push(value);
          break;
        case 'rate':
          if (!takeRate(value)) comments.push(`Курс: ${value}`);
          break;
        case 'sheet':
          warnings.push(`«${value}» не схоже на посилання, пропускаю.`);
          break;
      }
      continue;
    }

    const number = NUMBER_ONLY.exec(line);
    if (number) {
      comments.push(`№ ${number[1]!}`);
      continue;
    }
    if (normalizeDate(line)) {
      takeDate(line);
      continue;
    }
    const bare = found.total === null ? bareAmount(line) : null;
    if (bare) {
      found.total = bare.amount;
      if (bare.note) comments.push(bare.note);
      continue;
    }
    if (paymentAmount(line) || CARD.test(line) || IBAN.test(line)) {
      rest.push({ text: line, kind: 'text' });
      continue;
    }
    if (found.ourFop === null && FOP_PREFIX.test(line)) {
      takeOurFop(line);
      continue;
    }
    // After a heading such as «Платіжна установа:» a «ТОВ …» line is a bank detail, not our company.
    if (found.ourFop === null && COMPANY_PREFIX.test(line) && !before.endsWith(':')) {
      takeOurFop(line);
      continue;
    }
    const lone = loneRate(line);
    if (lone !== null && takeRate(lone)) {
      continue;
    }
    const note = line.replace(/["“”«»]/gu, '').trim();
    const asName = splitPeriod(note).name;
    if (found.name === null && asName !== '' && !BANK_NOISE.test(asName)) {
      found.name = note;
    } else if (note !== '' && !BANK_NOISE.test(note)) {
      comments.push(note);
    }
  }

  const paidAt = found.date ? parseDateTime(found.date) : null;
  const requisiteLines = deriveRequisiteLines(rest, paidAt ?? undefined);
  const accounts = rest.filter(
    (l) => l.kind === 'text' && (CARD.test(l.text) || IBAN.test(l.text)),
  );
  if (requisiteLines.length === 0 && accounts.length === 1 && found.total !== null) {
    const line = accounts[0]!.text;
    const holder = cleanName(line).replace(ON_CARD, '').trim();
    requisiteLines.push({
      payerName: holder !== '' && !BANK_NOISE.test(holder) ? holder : 'Не вказано',
      account: (CARD.exec(line) ?? IBAN.exec(line))![0],
      amount: found.total.toFixed(2),
      paidAt: paidAt ?? new Date(),
    });
  }
  const errors: string[] = [];
  const { name, period } = splitPeriod(found.name ?? '');
  if (name === '') {
    errors.push('Не знайшов клієнта. Додайте рядок «Клієнт: Прізвище Ім’я».');
  }

  const lineTotal = sum(requisiteLines.map((line) => new Prisma.Decimal(line.amount)));
  let stated = found.total;
  if (stated === null && requisiteLines.length > 0) {
    stated = lineTotal;
    warnings.unshift('Суму порахував з платежів, перевірте.');
  } else if (stated !== null && requisiteLines.length > 0 && !lineTotal.equals(stated)) {
    warnings.push(
      `Платежі разом ${money(lineTotal)}, а сума ${money(stated)} (різниця ${money(lineTotal.minus(stated).abs())}).`,
    );
  }
  if (stated === null) {
    errors.push('Не знайшов суму. Додайте рядок «Сума: 27 409 грн».');
  } else if (!MONEY_PATTERN.test(stated.toFixed(2))) {
    errors.push('Сума має бути додатною й не більшою за 12 цифр до коми.');
  }
  if (!found.date || !TIME_IN_DATE.test(found.date)) {
    errors.push(`Не вказано дату й час оплати. Напишіть ${DATE_TIME_HINT}.`);
  } else if (!paidAt) {
    errors.push(`Такої дати немає: «${found.date}». Напишіть ${DATE_TIME_HINT}.`);
  }
  if (found.ourFop === null && requisiteLines.length === 0) {
    errors.push(
      'Не вказано ФОП чи ТОВ. Додайте рядок «Отримано на: ФОП Берчатов М. М.» або «Отримано на: ТОВ Назва».',
    );
  }
  if (errors.length > 0 || stated === null) {
    return { ok: false, errors };
  }

  return {
    ok: true,
    plan: {
      clientName: name.slice(0, 255),
      period: period?.slice(0, 255) ?? null,
      paidAt,
      currency,
      total: stated,
      ourFop: found.ourFop,
      requisiteLines,
      comment: comments.length > 0 ? comments.join(' · ').slice(0, 2000) : null,
      rate: found.rate,
      sheetUrl: found.sheetUrl,
      warnings,
    },
  };
}
