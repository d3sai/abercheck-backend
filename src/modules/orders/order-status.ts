import { OrderStatus, Prisma } from '../../generated/prisma/client';

export const UNPAID_STATUSES: OrderStatus[] = [
  OrderStatus.AWAITING_PAYMENT,
  OrderStatus.PARTIALLY_PAID,
  OrderStatus.UNDERPAID,
];

// Managers and 1C treat 99–101 % as paid in full: the rate in 1C is tied to the sale date, so the
// UAH amount in the bot drifts by about a percent.
export const PAYMENT_TOLERANCE = new Prisma.Decimal('0.01');

export function calculateOrderStatus(
  amountDue: Prisma.Decimal,
  amountPaid: Prisma.Decimal,
  current: OrderStatus,
): OrderStatus {
  if (current === OrderStatus.CANCELLED) {
    return current;
  }
  if (amountPaid.isZero()) {
    return OrderStatus.AWAITING_PAYMENT;
  }

  const diff = amountPaid.minus(amountDue);
  if (diff.abs().lessThanOrEqualTo(amountDue.times(PAYMENT_TOLERANCE))) {
    return OrderStatus.PAID;
  }
  return diff.greaterThan(0) ? OrderStatus.OVERPAID : OrderStatus.PARTIALLY_PAID;
}
