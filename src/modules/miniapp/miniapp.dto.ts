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
import type { EditRequestBody, RequestKind } from '../finance-sync/finance.types';
import type { CreateRequestInput } from '../finance-sync/request-create.service';
import { EXCHANGE_RATE_PATTERN } from '../orders/dto/create-order.dto';
import { parseOrderNumber } from '../telegram/order-draft/order-draft.parsers';

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

function requiredRate(value: string | undefined | null): string {
  if (!value?.trim()) throw invalid('Вкажіть курс.');
  return rate(value);
}

const text = (value: string | undefined | null): string | null => {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed === '' ? null : trimmed;
};

export function toCreateInput(dto: CreateMiniappRequestDto): CreateRequestInput {
  const common = {
    kind: dto.kind,
    exchangeRate:
      dto.kind === 'minus' ? optionalRate(dto.exchangeRate) : requiredRate(dto.exchangeRate),
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
        exchangeRate: optionalRate(row.exchangeRate),
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
