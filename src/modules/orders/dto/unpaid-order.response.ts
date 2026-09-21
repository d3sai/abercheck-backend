import type { OrderStatus } from '../../../generated/prisma/client';
import type { OrderWithPaid } from '../orders.service';

export interface UnpaidOrderResponse {
  order_number: string;
  order_numbers: string[];
  client_name: string;
  amount_due: string;
  amount_paid: string;
  amount_remaining: string;
  status: OrderStatus;
  created_at: string;
}

export function toUnpaidOrderResponse({
  order,
  amountPaid,
  orderNumbers,
}: OrderWithPaid): UnpaidOrderResponse {
  return {
    order_number: order.orderNumber,
    order_numbers: orderNumbers ?? [order.orderNumber],
    client_name: order.clientName,
    amount_due: order.amountDue.toFixed(2),
    amount_paid: amountPaid.toFixed(2),
    amount_remaining: order.amountDue.minus(amountPaid).toFixed(2),
    status: order.status,
    created_at: order.createdAt.toISOString(),
  };
}
