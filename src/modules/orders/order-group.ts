import { type Order, OrderStatus, Prisma } from '../../generated/prisma/client';
import { calculateOrderStatus } from './order-status';
import { partIndexOf } from './order-number';

const ZERO = new Prisma.Decimal(0);

export interface GroupSummary {
  due: Prisma.Decimal;
  paid: Prisma.Decimal;
  status: OrderStatus;
}

export function liveParts<T extends Pick<Order, 'status'>>(parts: T[]): T[] {
  return parts.filter((part) => part.status !== OrderStatus.CANCELLED);
}

export function pickAnchor<T extends Pick<Order, 'status'>>(parts: T[]): T {
  const anchor = liveParts(parts)[0] ?? parts[0];
  if (!anchor) {
    throw new Error('Order group has no parts');
  }
  return anchor;
}

export function nextPartIndex(parts: Pick<Order, 'orderNumber'>[]): number {
  return parts.length === 0 ? 0 : Math.max(...parts.map((p) => partIndexOf(p.orderNumber))) + 1;
}

export function summarizeGroup(
  parts: Pick<Order, 'amountDue' | 'status'>[],
  paid: Prisma.Decimal,
): GroupSummary {
  const live = liveParts(parts);
  const first = live[0];
  if (!first) {
    return { due: ZERO, paid, status: OrderStatus.CANCELLED };
  }
  const due = live.reduce((sum, part) => sum.plus(part.amountDue), ZERO);
  return { due, paid, status: calculateOrderStatus(due, paid, first.status) };
}

export function allocateShares(
  parts: Pick<Order, 'id' | 'amountDue' | 'status'>[],
  paid: Prisma.Decimal,
): Map<number, Prisma.Decimal> {
  const shares = new Map<number, Prisma.Decimal>(parts.map((part) => [part.id, ZERO]));
  const live = liveParts(parts);
  let left = paid.greaterThan(0) ? paid : ZERO;
  live.forEach((part, index) => {
    const share = index === live.length - 1 ? left : Prisma.Decimal.min(part.amountDue, left);
    shares.set(part.id, share);
    left = left.minus(share);
  });
  return shares;
}

export function rollUp<T extends Order>(parts: T[]): T {
  const anchor = pickAnchor(parts);
  const live = liveParts(parts);
  const counted = live.length > 0 ? live : parts;
  return {
    ...anchor,
    orderNumber: anchor.baseNumber,
    clientName: [...new Set(counted.map((part) => part.clientName))].join(', '),
    amountDue: counted.reduce((sum, part) => sum.plus(part.amountDue), ZERO),
  };
}
