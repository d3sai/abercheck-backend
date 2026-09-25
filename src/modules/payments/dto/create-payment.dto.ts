import { Transform } from 'class-transformer';
import {
  IsEnum,
  IsISO8601,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
} from 'class-validator';
import { MONEY_PATTERN } from '../../../common/money';
import { Trim } from '../../../common/trim.decorator';
import { Currency } from '../../../generated/prisma/client';

const ISO_WITH_OFFSET = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,6})?)?(Z|[+-]\d{2}:\d{2})$/;

export class CreatePaymentDto {
  @Trim()
  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  external_transaction_id!: string;

  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() || null : value,
  )
  @IsOptional()
  @IsString()
  @MaxLength(128)
  order_number?: string | null;

  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'number' ? String(value) : typeof value === 'string' ? value.trim() : value,
  )
  @Matches(MONEY_PATTERN, { message: 'amount must be a positive amount with up to 2 decimals' })
  amount!: string;

  // Absent means hryvnias, so senders that predate the field keep working.
  @IsOptional()
  @IsEnum(Currency)
  currency?: Currency;

  @Trim()
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  payer_name!: string;

  @Trim()
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  receiving_account!: string;

  @IsString()
  @MaxLength(1000)
  purpose_text!: string;

  @Matches(ISO_WITH_OFFSET, { message: 'paid_at must be ISO 8601 with a timezone offset' })
  @IsISO8601({ strict: true })
  paid_at!: string;
}
