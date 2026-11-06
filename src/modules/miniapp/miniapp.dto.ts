import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
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
  @MaxLength(16)
  exchangeRate?: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  comment?: string;

  @IsBoolean()
  officialDocs!: boolean;
}

export class EditMiniappRequestDto {
  @IsOptional()
  @IsString()
  @MaxLength(16)
  exchangeRate?: string;

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

/** Shape only; the per-kind rules live in `toPayments`. */
export class CompleteMiniappRequestDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_PAYMENTS)
  @ValidateNested({ each: true })
  @Type(() => PaymentRowDto)
  payments!: PaymentRowDto[];

  /** The manager agreed to add the request's number as one more part of an existing order. */
  @IsOptional()
  @IsBoolean()
  addPart?: boolean;
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

const optionalRate = (value: string | undefined | null): string | null =>
  value?.trim() ? rate(value) : null;

function requiredRate(value: string | undefined | null, orderNumber: string): string {
  if (!value?.trim()) throw invalid(`Вкажіть курс для № ${orderNumber}.`);
  return rate(value);
}

const text = (value: string | undefined | null): string | null => {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed === '' ? null : trimmed;
};

export function toCreateInput(dto: CreateMiniappRequestDto): CreateRequestInput {
  const common = {
    kind: dto.kind,
    // the form asks for a rate per order number, not for the whole request
    exchangeRate: optionalRate(dto.exchangeRate),
    comment: text(dto.comment),
    officialDocs: dto.officialDocs,
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
    return { ...common, orders };
  }

  const clientLabel = text(dto.clientLabel);
  if (!clientLabel) throw invalid('Вкажіть клієнта.');
  return {
    ...common,
    sum: money(dto.sum),
    clientLabel,
    sheetUrl: text(dto.sheetUrl),
    withPercent: dto.kind === 'minus' ? (dto.withPercent ?? null) : null,
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
    ...(dto.exchangeRate != null && { exchangeRate: Number(rate(dto.exchangeRate)) }),
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

/** Date and time are required for every kind except our_fop; several rows only for foreign_fop and card. */
export function toPayments(kind: RequestKind, rows: PaymentRowDto[]): Payment[] {
  const withPayers = kind === 'foreign_fop' || kind === 'card';
  if (rows.length < 1 || rows.length > MAX_PAYMENTS) {
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
      paidAt: paidAt(row.date, time),
    };
  });
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
  const paid = paidAt(dto.date, time);
  if (paid.getTime() > now.getTime())
    throw invalid('Дата й час оплати не можуть бути в майбутньому.');
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
