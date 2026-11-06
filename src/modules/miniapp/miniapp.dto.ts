import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { HttpStatus } from '@nestjs/common';
import { ApiError } from '../../common/api-error';
import { kyivDateTime, kyivParts } from '../../common/kyiv-time';
import { MONEY_PATTERN } from '../../common/money';
import { Currency, Prisma } from '../../generated/prisma/client';
import type { EditRequestBody, RequestKind } from '../finance-sync/finance.types';
import type { CreateRequestInput } from '../finance-sync/request-create.service';
import type { StoredPayment } from '../finance-sync/stored-payments';
import { EXCHANGE_RATE_PATTERN } from '../orders/dto/create-order.dto';
import type { CashPlan } from '../telegram/order-draft/cash.parser';
import type { ForeignPlan } from '../telegram/order-draft/foreign.parser';
import type { KitPlan } from '../telegram/order-draft/kit.parser';
import { parseExchangeRate, parseOrderNumber } from '../telegram/order-draft/order-draft.parsers';

// Mirror finance-backend internal-requests.dto.ts
const MAX_ORDERS = 20;
const MAX_RATE = 1000;
const KINDS: readonly RequestKind[] = ['our_fop', 'foreign_fop', 'card', 'minus'];
const MAX_PAYMENTS = 10;
const ORDER_KINDS: readonly RequestKind[] = ['our_fop', 'foreign_fop', 'card'];

export class MiniappOrderDto {
  @IsString()
  @MaxLength(32)
  orderNumber!: string;

  @IsString()
  @MaxLength(32)
  amount!: string;

  @IsOptional()
  @IsString()
  @MaxLength(16)
  exchangeRate?: string;
}

/** Shape only; the per-kind rules live in `toCreateInput`, which answers with the repo ApiError body. */
export class CreateMiniappRequestDto {
  @IsIn(KINDS)
  kind!: RequestKind;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_ORDERS)
  @ValidateNested({ each: true })
  @Type(() => MiniappOrderDto)
  orders?: MiniappOrderDto[];

  @IsOptional()
  @IsString()
  @MaxLength(32)
  sum?: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  clientLabel?: string;

  @IsOptional()
  @IsString()
  @MaxLength(1024)
  sheetUrl?: string;

  @IsOptional()
  @IsBoolean()
  withPercent?: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  comment?: string;

  @IsBoolean()
  officialDocs!: boolean;

  /** foreign_fop, card and minus: what the client already paid; our_fop sends none. */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_PAYMENTS)
  @ValidateNested({ each: true })
  @Type(() => PaymentRowDto)
  payments?: PaymentRowDto[];
}

export class EditMiniappRequestDto {
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  comment?: string | null;

  @IsOptional()
  @IsBoolean()
  officialDocs?: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(32)
  sum?: string;
}

export class PaymentRowDto {
  @IsOptional()
  @IsString()
  @MaxLength(255)
  payerName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  account?: string;

  @IsString()
  @MaxLength(32)
  amount!: string;

  @IsString()
  @MaxLength(10)
  date!: string;

  @IsOptional()
  @IsString()
  @MaxLength(5)
  time?: string;
}

/** The request's own number with the amount and the rate the orders get instead of finance's. */
export class CompleteOrderDto {
  @IsString()
  @MaxLength(32)
  orderNumber!: string;

  @IsString()
  @MaxLength(32)
  amount!: string;

  @IsString()
  @MaxLength(16)
  exchangeRate!: string;
}

/** Shape only; the per-kind rules live in `toPayments` and `toOrderOverrides`. */
export class CompleteMiniappRequestDto {
  /** May be empty for our_fop: the client has not paid yet. */
  @IsArray()
  @ArrayMaxSize(MAX_PAYMENTS)
  @ValidateNested({ each: true })
  @Type(() => PaymentRowDto)
  payments!: PaymentRowDto[];

  /** Amounts and rates of the request's own numbers; all of them or none. */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_ORDERS)
  @ValidateNested({ each: true })
  @Type(() => CompleteOrderDto)
  orders?: CompleteOrderDto[];

  /** Replaces the order comment; blank clears it. */
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  comment?: string;

  /** The manager agreed to add the request's number as one more part of an existing order. */
  @IsOptional()
  @IsBoolean()
  addPart?: boolean;
}

export class PaidMiniappRequestDto {
  @IsString()
  @MaxLength(10)
  date!: string;

  @IsOptional()
  @IsString()
  @MaxLength(5)
  time?: string;
}

const invalid = (message: string): ApiError =>
  new ApiError(HttpStatus.BAD_REQUEST, 'invalid-request', message);

function money(value: string | undefined): string {
  const trimmed = value?.trim();
  if (trimmed === undefined || !MONEY_PATTERN.test(trimmed)) {
    throw invalid('Вкажіть суму числом, до копійок: 6158.41');
  }
  return trimmed;
}

function rate(value: string): string {
  const trimmed = value.trim();
  if (!EXCHANGE_RATE_PATTERN.test(trimmed) || Number(trimmed) > MAX_RATE) {
    throw invalid(`Вкажіть курс числом до ${MAX_RATE}: 44.9`);
  }
  return trimmed;
}

function requiredRate(value: string | undefined | null, orderNumber: string): string {
  if (!value?.trim()) throw invalid(`Вкажіть курс для № ${orderNumber}.`);
  return rate(value);
}

const text = (value: string | undefined | null): string | null => {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed === '' ? null : trimmed;
};

export function toCreateInput(dto: CreateMiniappRequestDto, now = new Date()): CreateRequestInput {
  const common = {
    kind: dto.kind,
    comment: text(dto.comment),
    // official documents are a choice only for «Наш ФОП»; the other kinds go without them
    officialDocs: dto.kind === 'our_fop' ? dto.officialDocs : false,
  };

  if (ORDER_KINDS.includes(dto.kind)) {
    const rows = dto.orders ?? [];
    if (rows.length < 1 || rows.length > MAX_ORDERS) {
      throw invalid(`Додайте від 1 до ${MAX_ORDERS} замовлень.`);
    }
    const seen = new Set<string>();
    const orders = rows.map((row) => {
      const number = parseOrderNumber(row.orderNumber);
      if (!number.ok) throw invalid(number.error);
      if (seen.has(number.value)) throw invalid(`Номер ${number.value} повторюється.`);
      seen.add(number.value);
      return {
        orderNumber: number.value,
        amount: money(row.amount),
        exchangeRate: requiredRate(row.exchangeRate, number.value),
      };
    });
    if (dto.kind === 'our_fop') {
      if ((dto.payments ?? []).length > 0) {
        throw invalid('Для «Наш ФОП» платіж ще не вказують: клієнт не оплатив.');
      }
      return { ...common, orders };
    }
    return { ...common, orders, payments: storable(toPayments(dto.kind, dto.payments ?? [], now)) };
  }

  const clientLabel = text(dto.clientLabel);
  if (!clientLabel) throw invalid('Вкажіть клієнта.');
  const sum = money(dto.sum);
  const payments = toPayments('minus', dto.payments ?? [], now);
  if (!new Prisma.Decimal(payments[0]!.amount).equals(sum)) {
    throw invalid('Сума платежу має дорівнювати сумі мінусу.');
  }
  return {
    ...common,
    sum,
    clientLabel,
    sheetUrl: text(dto.sheetUrl),
    withPercent: dto.kind === 'minus' ? (dto.withPercent ?? null) : null,
    payments: storable(payments),
  };
}

/** Only the fields the manager sent; finance enforces «pending only» and «sum only for minus». */
export function toEditBody(
  dto: EditMiniappRequestDto,
  requesterTelegramId: number,
): EditRequestBody {
  // `@IsOptional` lets null through, so null counts as absent
  return {
    requesterTelegramId,
    ...(dto.sum != null && { sum: Number(money(dto.sum)) }),
    ...(dto.comment != null && { comment: text(dto.comment) }),
    ...(dto.officialDocs != null && { officialDocs: dto.officialDocs }),
  };
}

export interface Payment {
  payerName: string | null;
  account: string | null;
  amount: string;
  paidAt: Date;
}

const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** A Kyiv wall-clock date and time; a day the calendar does not have is refused. */
function paidAt(date: string, time: string | null): Date {
  const day = DATE_PATTERN.exec(date.trim());
  const clock = time === null ? null : TIME_PATTERN.exec(time);
  if (!day || (time !== null && !clock)) throw invalid('Вкажіть дату як 2026-11-04, час як 14:30.');
  const [year, month, dayOfMonth] = [Number(day[1]), Number(day[2]), Number(day[3])];
  const result = kyivDateTime(
    year,
    month,
    dayOfMonth,
    Number(clock?.[1] ?? 0),
    Number(clock?.[2] ?? 0),
  );
  const back = kyivParts(result);
  if (
    Number(back.year) !== year ||
    Number(back.month) !== month ||
    Number(back.day) !== dayOfMonth
  ) {
    throw invalid(`Такої дати немає: ${date}.`);
  }
  return result;
}

const notInFuture = (paid: Date, now: Date): Date => {
  if (paid.getTime() > now.getTime()) {
    throw invalid('Дата й час оплати не можуть бути в майбутньому.');
  }
  return paid;
};

/**
 * Date and time are required for every kind except our_fop, which may have no payment at all (the
 * client has not paid yet); several rows only for foreign_fop and card. Never in the future.
 */
export function toPayments(kind: RequestKind, rows: PaymentRowDto[], now = new Date()): Payment[] {
  const withPayers = kind === 'foreign_fop' || kind === 'card';
  if (rows.length < (kind === 'our_fop' ? 0 : 1) || rows.length > MAX_PAYMENTS) {
    throw invalid(`Додайте від 1 до ${MAX_PAYMENTS} платежів.`);
  }
  if (!withPayers && rows.length > 1) throw invalid('Для цього запиту потрібна одна дата оплати.');
  return rows.map((row) => {
    const time = text(row.time);
    if (kind !== 'our_fop' && time === null) throw invalid('Вкажіть дату й час оплати.');
    const payerName = text(row.payerName);
    if (withPayers && payerName === null) throw invalid('Вкажіть, хто платив.');
    return {
      payerName,
      account: text(row.account),
      amount: money(row.amount),
      paidAt: notInFuture(paidAt(row.date, time), now),
    };
  });
}

const storable = (payments: Payment[]): StoredPayment[] =>
  payments.map((payment) => ({
    payerName: payment.payerName,
    account: payment.account,
    amount: new Prisma.Decimal(payment.amount).toFixed(2),
    paidAt: payment.paidAt.toISOString(),
  }));

/** The card keeps payments validated at creation, so they come back without another look. */
export const fromStored = (payments: StoredPayment[]): Payment[] =>
  payments.map((payment) => ({ ...payment, paidAt: new Date(payment.paidAt) }));

/** The orders' own amounts and rates by number; the numbers must be exactly the request's. */
export function toOrderOverrides(
  rows: CompleteOrderDto[] | null | undefined,
  requestNumbers: string[],
): Map<string, { amount: string; exchangeRate: string }> {
  const overrides = new Map<string, { amount: string; exchangeRate: string }>();
  if (rows == null) return overrides;
  for (const row of rows) {
    const number = parseOrderNumber(row.orderNumber);
    if (!number.ok) throw invalid(number.error);
    if (!requestNumbers.includes(number.value)) {
      throw invalid(`Номер ${number.value} не належить цьому запиту.`);
    }
    if (overrides.has(number.value)) throw invalid(`Номер ${number.value} повторюється.`);
    overrides.set(number.value, {
      amount: money(row.amount),
      exchangeRate: requiredRate(row.exchangeRate, number.value),
    });
  }
  const missing = requestNumbers.find((number) => !overrides.has(number));
  if (missing !== undefined)
    throw invalid(`Бракує № ${missing}: вкажіть суму й курс усіх номерів.`);
  return overrides;
}

/** The day and time the client paid, Kyiv time; the time is optional. */
export function toPaidAt(dto: PaidMiniappRequestDto, now = new Date()): Date {
  return notInFuture(paidAt(dto.date, text(dto.time)), now);
}

export class MiniappKitItemDto {
  @IsString()
  @MaxLength(32)
  orderNumber!: string;

  @IsString()
  @MaxLength(32)
  amount!: string;
}

const ORDER_PAYMENT_KINDS = ['kit', 'cash', 'foreign'] as const;
export type OrderPaymentKind = (typeof ORDER_PAYMENT_KINDS)[number];

/** Shape only; the per-kind rules live in `toOrderPlan`. */
export class CreateMiniappOrderDto {
  @IsIn(ORDER_PAYMENT_KINDS)
  kind!: OrderPaymentKind;

  /** Kit */
  @IsOptional()
  @IsString()
  @MaxLength(64)
  accessCode?: string;

  /** Kit */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_ORDERS)
  @ValidateNested({ each: true })
  @Type(() => MiniappKitItemDto)
  items?: MiniappKitItemDto[];

  /** Cash and foreign */
  @IsOptional()
  @IsString()
  @MaxLength(32)
  orderNumber?: string;

  /** Cash and foreign */
  @IsOptional()
  @IsString()
  @MaxLength(32)
  amount?: string;

  /** Cash: UAH or USD; foreign: UAH, USD or EUR. */
  @IsOptional()
  @IsIn(Object.values(Currency))
  currency?: Currency;

  /** Cash and foreign */
  @IsOptional()
  @IsString()
  @MaxLength(16)
  rate?: string;

  /** Foreign */
  @IsOptional()
  @IsString()
  @MaxLength(255)
  recipient?: string;

  /** Cash */
  @IsOptional()
  @IsString()
  @MaxLength(255)
  handedBy?: string;

  /** Cash */
  @IsOptional()
  @IsBoolean()
  withPercent?: boolean;

  @IsString()
  @MaxLength(10)
  date!: string;

  @IsOptional()
  @IsString()
  @MaxLength(5)
  time?: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  comment?: string;
}

export type OrderPlan =
  | { kind: 'kit'; plan: KitPlan }
  | { kind: 'cash'; plan: CashPlan }
  | { kind: 'foreign'; plan: ForeignPlan };

function orderNumber(value: string | undefined): string {
  const number = parseOrderNumber(value ?? '');
  if (!number.ok) throw invalid(number.error);
  return number.value;
}

function requiredRateValue(value: string | undefined): string {
  const parsed = parseExchangeRate(value ?? '');
  if (!parsed.ok || Number(parsed.value) > MAX_RATE) {
    throw invalid(`Вкажіть курс числом до ${MAX_RATE}: 44.9`);
  }
  return parsed.value;
}

function requiredText(value: string | undefined, message: string): string {
  const trimmed = text(value);
  if (trimmed === null) throw invalid(message);
  return trimmed;
}

function currencyOf(value: Currency | undefined, allowed: readonly Currency[]): Currency {
  if (!value || !allowed.includes(value)) {
    throw invalid(`Оберіть валюту: ${allowed.join(', ')}.`);
  }
  return value;
}

/** Builds the same plan the text parsers build, from the form's fields; the date is a past Kyiv date. */
export function toOrderPlan(dto: CreateMiniappOrderDto, now = new Date()): OrderPlan {
  const time = text(dto.time);
  if (dto.kind !== 'foreign' && time === null) throw invalid('Вкажіть дату й час оплати.');
  const paid = notInFuture(paidAt(dto.date, time), now);
  const comment = text(dto.comment);

  if (dto.kind === 'kit') {
    const rows = dto.items ?? [];
    if (rows.length < 1 || rows.length > MAX_ORDERS) {
      throw invalid(`Додайте від 1 до ${MAX_ORDERS} замовлень.`);
    }
    const seen = new Set<string>();
    const items = rows.map((row) => {
      const number = orderNumber(row.orderNumber);
      if (seen.has(number)) throw invalid(`Номер ${number} повторюється.`);
      seen.add(number);
      return { number, amount: new Prisma.Decimal(money(row.amount)) };
    });
    return {
      kind: 'kit',
      plan: {
        accessCode: requiredText(dto.accessCode, 'Вкажіть код доступу.'),
        total: items.reduce((total, item) => total.plus(item.amount), new Prisma.Decimal(0)),
        items,
        paidAt: paid,
        comment,
        warnings: [],
      },
    };
  }

  const number = orderNumber(dto.orderNumber);
  const amount = new Prisma.Decimal(money(dto.amount));
  const rate = requiredRateValue(dto.rate);
  if (dto.kind === 'cash') {
    return {
      kind: 'cash',
      plan: {
        number,
        amount,
        currency: currencyOf(dto.currency, [Currency.UAH, Currency.USD]),
        rate,
        paidAt: paid,
        handedBy: requiredText(dto.handedBy, 'Вкажіть, ким передано.'),
        withPercent: dto.withPercent ?? null,
        comment,
        warnings: [],
      },
    };
  }
  return {
    kind: 'foreign',
    plan: {
      number,
      amount,
      currency: currencyOf(dto.currency, [Currency.UAH, Currency.USD, Currency.EUR]),
      recipient: requiredText(dto.recipient, 'Вкажіть, на кого оплата.'),
      rate,
      paidAt: paid,
      comment,
      warnings: [],
    },
  };
}
