import type { Currency, OrderStatus } from '../../../generated/prisma/client';
import type { IngestionResult } from '../payment-ingestion.types';

export interface PaymentResponse {
  result: 'recorded' | 'unmatched' | 'already_processed';
  payment_id: number;
  currency: Currency;
  order_number: string | null;
  order_status: OrderStatus | null;
}

export function toPaymentResponse(result: IngestionResult): PaymentResponse {
  switch (result.kind) {
    case 'recorded':
      return {
        result: 'recorded',
        payment_id: result.payment.id,
        currency: result.payment.currency,
        order_number: result.order.orderNumber,
        order_status: result.order.status,
      };
    case 'unmatched':
      return {
        result: 'unmatched',
        payment_id: result.payment.id,
        currency: result.payment.currency,
        order_number: result.payment.reportedOrderNumber,
        order_status: null,
      };
    case 'duplicate':
      return {
        result: 'already_processed',
        payment_id: result.payment.id,
        currency: result.payment.currency,
        order_number: result.payment.reportedOrderNumber,
        order_status: null,
      };
  }
}
