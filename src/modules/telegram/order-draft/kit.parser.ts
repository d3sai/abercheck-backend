import { Currency, Prisma } from '../../../generated/prisma/client';
import { MONEY_PATTERN, UAH_UNIT_SRC } from '../../../common/money';
import { formatMoneyIn } from '../core/format';
import {
  AMOUNT_SRC,
  REQUISITES_MAX_LENGTH,
  parseDateTime,
  sum,
  toDecimal,
  unitAfterAmount,
} from './requisites.parser';

// "Оплата на Кит": one dollar transfer, found by its access code, spread over several 1C numbers.
export interface KitPlan {
  accessCode: string;
  total: Prisma.Decimal;
  items: { number: string; amount: Prisma.Decimal }[];
  paidAt: Date | null;
  comment: string | null;
  warnings: string[];
}

export type KitResult = { ok: true; plan: KitPlan } | { ok: false; errors: string[] };

const HEADER = /^оплата\s+на\s+кит\s*[:\-–—]?\s*$/iu;
const ACCESS_CODE = /^код(?:\s+доступу)?\s*[:\-–—]?\s*(.*)$/iu;
const TOTAL = /^(?:загальна\s+)?сума\s*[:\-–—]?\s*(.*)$/iu;
const DATE = /^дата(?:\s+(?:та|і)\s+час)?\s*[:\-–—]?\s*(.*)$/iu;
// "Замовлення та сума в доларах :" — the heading over the number lines.
const ITEMS_HEADING = /^замовлення(?!\p{L})[^\d]*$/iu;
const NUMBER = /(?<!\d)\d{4}-\d{6}(?!\d)/gu;
// Not glued to other digits, so "0000-062265" never lends its "062265" to the amount.
const AMOUNT = new RegExp(String.raw`(?<![\d.,-])(${AMOUNT_SRC})(?![\d-])`, 'u');
const HRYVNIAS = new RegExp(String.raw`\d\s*${UAH_UNIT_SRC}`, 'iu');

const usd = (value: Prisma.Decimal): string => formatMoneyIn(value, Currency.USD);

export function parseKit(raw: string): KitResult {
  if (raw.trim().length > REQUISITES_MAX_LENGTH) {
    return {
      ok: false,
      errors: [`Повідомлення задовге, максимум ${REQUISITES_MAX_LENGTH} символів.`],
    };
  }
  const text = unitAfterAmount(raw);
  if (HRYVNIAS.test(text)) {
    return { ok: false, errors: ['Оплата на Кит лише в доларах. Гривні надішліть окремо.'] };
  }

  let accessCode: string | null = null;
  let total: Prisma.Decimal | null = null;
  let date: string | null = null;
  const items: KitPlan['items'] = [];
  const comments: string[] = [];
  const errors: string[] = [];
  const warnings: string[] = [];

  for (const original of text.split(/\r?\n/)) {
    const line = original.replace(/\s+/g, ' ').trim();
    if (line === '' || HEADER.test(line) || ITEMS_HEADING.test(line)) {
      continue;
    }
    const numbers = line.match(NUMBER) ?? [];
    if (numbers.length > 1) {
      errors.push(`Кожен номер з нового рядка: «${line}».`);
      continue;
    }
    if (numbers.length === 1) {
      const number = numbers[0];
      const amount = AMOUNT.exec(line.replace(number, ' '));
      if (!amount) {
        errors.push(`Не знайшов суму для № ${number}.`);
      } else if (items.some((item) => item.number === number)) {
        errors.push(`№ ${number} двічі.`);
      } else {
        items.push({ number, amount: toDecimal(amount[1]!) });
      }
      continue;
    }

    const code = ACCESS_CODE.exec(line);
    if (code) {
      if (code[1]!.trim() !== '') accessCode = code[1]!.trim().slice(0, 64);
      continue;
    }
    const totalLine = TOTAL.exec(line);
    if (totalLine) {
      const amount = AMOUNT.exec(totalLine[1]!);
      if (amount) {
        total = toDecimal(amount[1]!);
      } else {
        warnings.push(`Не розібрав суму «${totalLine[1]}».`);
      }
      continue;
    }
    const dateLine = DATE.exec(line);
    if (dateLine) {
      date = dateLine[1]!.trim();
      continue;
    }
    if (parseDateTime(line)) {
      date = line;
      continue;
    }
    comments.push(line);
  }

  if (!accessCode) {
    errors.push('Не знайшов код доступу. Додайте рядок «Код доступу: 647143353».');
  }
  if (items.length === 0) {
    errors.push('Не знайшов жодного замовлення. Кожен номер із сумою з нового рядка.');
  }
  for (const item of items) {
    if (!MONEY_PATTERN.test(item.amount.toFixed(2))) {
      errors.push(`Сума для № ${item.number} має бути більшою за нуль.`);
    }
  }
  if (errors.length > 0 || !accessCode) {
    return { ok: false, errors };
  }

  const itemsTotal = sum(items.map((item) => item.amount));
  if (total === null) {
    total = itemsTotal;
    warnings.unshift('Загальну суму порахував із замовлень, перевірте.');
  } else if (!total.equals(itemsTotal)) {
    warnings.push(
      `Замовлення разом ${usd(itemsTotal)}, а переказ ${usd(total)} (різниця ${usd(itemsTotal.minus(total).abs())}).`,
    );
  }
  const paidAt = date ? parseDateTime(date) : null;
  if (!date) {
    warnings.push('Не вказано дату.');
  } else if (!paidAt) {
    warnings.push(`Не розібрав дату «${date}». Формат: 21.08.2026 14:44.`);
  }

  return {
    ok: true,
    plan: {
      accessCode,
      total,
      items,
      paidAt,
      comment: comments.length > 0 ? comments.join(' · ').slice(0, 1000) : null,
      warnings,
    },
  };
}
