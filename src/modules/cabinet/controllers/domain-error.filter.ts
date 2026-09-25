import { type ArgumentsHost, Catch, type ExceptionFilter, HttpStatus } from '@nestjs/common';
import type { Response } from 'express';
import { MulterError } from 'multer';
import {
  AttachmentNotFoundError,
  AttachmentStorageError,
  UnsupportedFileTypeError,
} from '../../attachments/attachments.errors';
import { MAX_FILE_SIZE_BYTES, MAX_FILES_PER_UPLOAD } from '../../attachments/attachments.constants';
import { ApiError } from '../../../common/api-error';
import {
  OrderCancelledError,
  OrderCurrencyMismatchError,
  OrderNotFoundError,
  OrderNumberTakenError,
} from '../../orders/orders.errors';
import { PaymentAlreadyAttachedError, PaymentNotFoundError } from '../../payments/payments.errors';
import {
  NothingToRefundError,
  OrderHasPaymentsError,
  RefundAmountError,
} from '../../refunds/refunds.errors';
import { formatMoneyIn } from '../../telegram/core/format';

type DomainError =
  | OrderNotFoundError
  | OrderNumberTakenError
  | OrderCancelledError
  | OrderCurrencyMismatchError
  | PaymentNotFoundError
  | PaymentAlreadyAttachedError
  | RefundAmountError
  | NothingToRefundError
  | OrderHasPaymentsError
  | AttachmentNotFoundError
  | AttachmentStorageError
  | UnsupportedFileTypeError
  | MulterError;

export function toApiError(error: DomainError): ApiError {
  if (error instanceof OrderNotFoundError) {
    return new ApiError(
      HttpStatus.NOT_FOUND,
      'ORDER_NOT_FOUND',
      `Замовлення № ${error.orderNumber} не знайдено`,
    );
  }
  if (error instanceof OrderNumberTakenError) {
    return new ApiError(
      HttpStatus.CONFLICT,
      'ORDER_NUMBER_TAKEN',
      `Замовлення № ${error.orderNumber} уже існує`,
    );
  }
  if (error instanceof OrderCancelledError) {
    return new ApiError(
      HttpStatus.CONFLICT,
      'ORDER_CANCELLED',
      `Замовлення № ${error.orderNumber} скасоване`,
    );
  }
  if (error instanceof OrderCurrencyMismatchError) {
    return new ApiError(
      HttpStatus.CONFLICT,
      'ORDER_CURRENCY_MISMATCH',
      `Платіж і замовлення № ${error.orderNumber} у різних валютах`,
    );
  }
  if (error instanceof PaymentNotFoundError) {
    return new ApiError(
      HttpStatus.NOT_FOUND,
      'PAYMENT_NOT_FOUND',
      `Платіж #${error.paymentId} не знайдено`,
    );
  }
  if (error instanceof PaymentAlreadyAttachedError) {
    return new ApiError(
      HttpStatus.CONFLICT,
      'PAYMENT_ALREADY_ATTACHED',
      `Платіж #${error.paymentId} уже прив'язано до замовлення`,
    );
  }
  if (error instanceof RefundAmountError) {
    return new ApiError(
      HttpStatus.UNPROCESSABLE_ENTITY,
      'REFUND_AMOUNT_INVALID',
      `Повернути можна від 0,01 до ${formatMoneyIn(error.available, error.currency)}`,
    );
  }
  if (error instanceof NothingToRefundError) {
    return new ApiError(
      HttpStatus.CONFLICT,
      'NOTHING_TO_REFUND',
      `За замовленням № ${error.orderNumber} повертати нічого`,
    );
  }
  if (error instanceof AttachmentNotFoundError) {
    return new ApiError(HttpStatus.NOT_FOUND, 'ATTACHMENT_NOT_FOUND', 'Файл не знайдено');
  }
  if (error instanceof AttachmentStorageError) {
    return new ApiError(
      HttpStatus.BAD_GATEWAY,
      'ATTACHMENT_STORAGE_FAILED',
      'Не вдалося зберегти або отримати файл через Telegram, спробуйте ще раз',
    );
  }
  if (error instanceof UnsupportedFileTypeError) {
    return new ApiError(
      HttpStatus.BAD_REQUEST,
      'ATTACHMENT_TYPE_INVALID',
      'Непідтримуваний тип файлу. Дозволені: зображення (JPG, PNG, WEBP, GIF) та PDF',
    );
  }
  if (error instanceof MulterError) {
    if (error.code === 'LIMIT_FILE_SIZE') {
      return new ApiError(
        HttpStatus.BAD_REQUEST,
        'ATTACHMENT_TOO_LARGE',
        `Файл занадто великий: максимум ${Math.floor(MAX_FILE_SIZE_BYTES / (1024 * 1024))} МБ`,
      );
    }
    if (error.code === 'LIMIT_FILE_COUNT' || error.code === 'LIMIT_UNEXPECTED_FILE') {
      return new ApiError(
        HttpStatus.BAD_REQUEST,
        'ATTACHMENT_TOO_MANY',
        `Занадто багато файлів за раз: максимум ${MAX_FILES_PER_UPLOAD}`,
      );
    }
    return new ApiError(
      HttpStatus.BAD_REQUEST,
      'ATTACHMENT_UPLOAD_FAILED',
      'Не вдалося завантажити файл',
    );
  }
  return new ApiError(
    HttpStatus.CONFLICT,
    'ORDER_HAS_PAYMENTS',
    `За замовленням № ${error.orderNumber} сплачено ${formatMoneyIn(error.paid, error.currency)} — спершу оформіть повернення`,
  );
}

@Catch(
  OrderNotFoundError,
  OrderNumberTakenError,
  OrderCancelledError,
  OrderCurrencyMismatchError,
  PaymentNotFoundError,
  PaymentAlreadyAttachedError,
  RefundAmountError,
  NothingToRefundError,
  OrderHasPaymentsError,
  AttachmentNotFoundError,
  AttachmentStorageError,
  UnsupportedFileTypeError,
  MulterError,
)
export class DomainErrorFilter implements ExceptionFilter<DomainError> {
  catch(error: DomainError, host: ArgumentsHost): void {
    const apiError = toApiError(error);
    host
      .switchToHttp()
      .getResponse<Response>()
      .status(apiError.getStatus())
      .json(apiError.getResponse());
  }
}
