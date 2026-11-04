import { HttpException, type HttpStatus } from '@nestjs/common';

export interface ApiErrorBody {
  statusCode: number;
  code: string;
  message: string;
  details?: Record<string, unknown>;
}

export class ApiError extends HttpException {
  constructor(
    status: HttpStatus,
    code: string,
    message: string,
    details?: Record<string, unknown>,
  ) {
    super(
      { statusCode: status, code, message, ...(details && { details }) } satisfies ApiErrorBody,
      status,
    );
  }
}
