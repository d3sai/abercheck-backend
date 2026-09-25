import type { Currency, Prisma } from '../../generated/prisma/client';

export class RefundAmountError extends Error {
  constructor(
    readonly orderNumber: string,
    readonly available: Prisma.Decimal,
    readonly currency: Currency,
  ) {
    super(`Refund for order ${orderNumber} must be between 0 and ${available.toFixed(2)}`);
    this.name = 'RefundAmountError';
  }
}

export class NothingToRefundError extends Error {
  constructor(readonly orderNumber: string) {
    super(`Order ${orderNumber} has no money to refund`);
    this.name = 'NothingToRefundError';
  }
}

export class OrderHasPaymentsError extends Error {
  constructor(
    readonly orderNumber: string,
    readonly paid: Prisma.Decimal,
    readonly currency: Currency,
  ) {
    super(`Order ${orderNumber} has ${paid.toFixed(2)} paid — refund it instead`);
    this.name = 'OrderHasPaymentsError';
  }
}
