import type { ArgumentsHost } from '@nestjs/common';
import {
  DomainErrorFilter,
  toApiError,
} from '../../../../src/modules/cabinet/controllers/domain-error.filter';
import { Currency, Prisma } from '../../../../src/generated/prisma/client';
import {
  OrderCancelledError,
  OrderCurrencyMismatchError,
  OrderNotFoundError,
  OrderNumberTakenError,
} from '../../../../src/modules/orders/orders.errors';
import {
  PaymentAlreadyAttachedError,
  PaymentNotFoundError,
} from '../../../../src/modules/payments/payments.errors';
import {
  NothingToRefundError,
  OrderHasPaymentsError,
  RefundAmountError,
} from '../../../../src/modules/refunds/refunds.errors';

const d = (value: string) => new Prisma.Decimal(value);

describe('DomainErrorFilter', () => {
  it.each([
    [new OrderNotFoundError('0000-066717'), 404, 'ORDER_NOT_FOUND'],
    [new OrderNumberTakenError('0000-066717'), 409, 'ORDER_NUMBER_TAKEN'],
    [new OrderCancelledError('0000-066717'), 409, 'ORDER_CANCELLED'],
    [new OrderCurrencyMismatchError('0000-066717'), 409, 'ORDER_CURRENCY_MISMATCH'],
    [new PaymentNotFoundError(15), 404, 'PAYMENT_NOT_FOUND'],
    [new PaymentAlreadyAttachedError(15), 409, 'PAYMENT_ALREADY_ATTACHED'],
    [
      new RefundAmountError('0000-066717', d('6158.41'), Currency.UAH),
      422,
      'REFUND_AMOUNT_INVALID',
    ],
    [new NothingToRefundError('0000-066717'), 409, 'NOTHING_TO_REFUND'],
    [new OrderHasPaymentsError('0000-066717', d('100'), Currency.UAH), 409, 'ORDER_HAS_PAYMENTS'],
  ])('should map %s', (error, status, code) => {
    const apiError = toApiError(error);

    expect(apiError.getStatus()).toBe(status);
    expect(apiError.getResponse()).toMatchObject({ statusCode: status, code });
  });

  it('should tell how much can be refunded, in the currency of the order', () => {
    const apiError = toApiError(new RefundAmountError('0000-066717', d('150'), Currency.USD));

    expect(apiError.getResponse()).toMatchObject({
      message: 'Повернути можна від 0,01 до 150 $',
    });
  });

  it('should tell how much can be refunded, in hryvnias', () => {
    const apiError = toApiError(new RefundAmountError('0000-066717', d('6158.41'), Currency.UAH));

    expect(apiError.getResponse()).toMatchObject({
      message: 'Повернути можна від 0,01 до 6 158,41 грн',
    });
  });

  it('should send the error as the JSON response', () => {
    const response = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    const host = {
      switchToHttp: () => ({ getResponse: () => response }),
    } as unknown as ArgumentsHost;

    new DomainErrorFilter().catch(new PaymentNotFoundError(15), host);

    expect(response.status).toHaveBeenCalledWith(404);
    expect(response.json).toHaveBeenCalledWith({
      statusCode: 404,
      code: 'PAYMENT_NOT_FOUND',
      message: 'Платіж #15 не знайдено',
    });
  });
});
