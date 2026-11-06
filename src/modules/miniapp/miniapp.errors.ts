import { HttpStatus } from '@nestjs/common';
import { ApiError } from '../../common/api-error';
import { FinanceApiError } from '../finance-sync/finance.types';

export const notFound = (): ApiError =>
  new ApiError(HttpStatus.NOT_FOUND, 'not-found', 'Запит не знайдено');

/** Finance's answer to a read or an edit, as the Mini App error body. */
export function financeError(error: unknown): unknown {
  if (!(error instanceof FinanceApiError)) return error;
  if (error.code === 'disabled') {
    return new ApiError(
      HttpStatus.SERVICE_UNAVAILABLE,
      'finance-disabled',
      'Ця функція ще не ввімкнена',
    );
  }
  if (error.status === 404) return notFound();
  if (error.status === 409 && error.code === 'order-taken') {
    const number = error.details?.orderNumber;
    return new ApiError(
      HttpStatus.CONFLICT,
      'order-taken',
      `Номер ${typeof number === 'string' ? number : ''} уже використовується в іншому запиті`.replace(
        '  ',
        ' ',
      ),
    );
  }
  if (error.status === 409) {
    return new ApiError(
      HttpStatus.CONFLICT,
      'already-closed',
      'Запит уже закрито, зміни неможливі',
    );
  }
  if (error.status === 400 && error.code === 'sum-locked') {
    return new ApiError(HttpStatus.BAD_REQUEST, 'sum-locked', 'Суму цього запиту змінити не можна');
  }
  if (error.status === 0 || error.status >= 500) {
    return new ApiError(
      HttpStatus.BAD_GATEWAY,
      'finance-no-answer',
      'Фінанси не відповіли, спробуйте ще раз',
    );
  }
  return new ApiError(
    HttpStatus.UNPROCESSABLE_ENTITY,
    'finance-refused',
    `Фінанси відхилили запит (${error.code}).`,
  );
}
