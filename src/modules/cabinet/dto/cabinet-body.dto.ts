import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsPositive,
  IsString,
  Matches,
  MaxLength,
} from 'class-validator';
import { MONEY_PATTERN } from '../../../common/money';
import { Trim } from '../../../common/trim.decorator';
import { ManagerRole, ManagerStatus } from '../../../generated/prisma/client';
import { CreateOrderDto } from '../../orders/dto/create-order.dto';

export class CabinetCreateOrderDto extends CreateOrderDto {
  @Type(() => Number)
  @IsOptional()
  @IsInt()
  @IsPositive()
  managerId?: number;

  // The number is already taken: create this order as one more part of it instead of failing.
  @IsOptional()
  @IsBoolean()
  addPart?: boolean;
}

export class RefundDto {
  @Trim()
  @IsOptional()
  @Matches(MONEY_PATTERN, { message: 'amount must be a positive amount with up to 2 decimals' })
  amount?: string;
}

export class AttachPaymentDto {
  @Trim()
  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  orderNumber!: string;
}

export class UpdateManagerDto {
  @IsOptional()
  @IsIn([ManagerStatus.ACTIVE, ManagerStatus.REJECTED])
  status?: ManagerStatus;

  @IsOptional()
  @IsEnum(ManagerRole)
  role?: ManagerRole;
}
