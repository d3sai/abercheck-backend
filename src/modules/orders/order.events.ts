import type { Order } from '../../generated/prisma/client';

export interface OrderCreated {
  order: Order;
}

export interface OrderDeleted {
  orderId: number;
}

export const OrderEvents = {
  Created: 'order.created',
  Deleted: 'order.deleted',
} as const;
