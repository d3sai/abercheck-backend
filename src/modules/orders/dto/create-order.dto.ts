import {
  IsEnum,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  ValidateIf,
} from 'class-validator';
import { MONEY_PATTERN } from '../../../common/money';
import { Trim } from '../../../common/trim.decorator';
import { OrderType } from '../../../generated/prisma/client';

export const EXCHANGE_RATE_PATTERN = /^(?!0+(\.0+)?$)\d{1,4}(\.\d{1,4})?$/;

export class CreateOrderDto {
  @IsOptional()
  @IsEnum(OrderType)
  orderType?: OrderType;

  @Trim()
  @ValidateIf((dto: CreateOrderDto) => dto.orderType !== OrderType.MINUS_CLOSING)
  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  orderNumber?: string;

  @Trim()
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  clientName!: string;

  @Trim()
  @Matches(MONEY_PATTERN, { message: 'amountDue must be a positive amount with up to 2 decimals' })
  amountDue!: string;

  @Trim()
  @IsOptional()
  @Matches(EXCHANGE_RATE_PATTERN, {
    message: 'exchangeRate must be a positive rate with up to 4 decimals',
  })
  exchangeRate?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  comment?: string;
}
