import { HttpStatus } from '@nestjs/common';
import { ApiError } from '../../common/api-error';

export const AdminOrdersErrors = {
  notFound: (orderNumber: string) =>
    new ApiError(HttpStatus.NOT_FOUND, 'ORDER_NOT_FOUND', `Замовлення ${orderNumber} не знайдено`),
  confirmMismatch: () =>
    new ApiError(
      HttpStatus.BAD_REQUEST,
      'CONFIRM_MISMATCH',
      'Підтвердження не збігається з номером замовлення',
    ),
};
