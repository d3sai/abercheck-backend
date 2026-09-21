import { type Order, OrderStatus, Prisma } from '../../generated/prisma/client';
import { type GroupSummary, summarizeGroup } from './order-group';

export async function lockOrderByNumber(
  tx: Prisma.TransactionClient,
  orderNumber: string,
): Promise<Order | null> {
  const rows = await tx.$queryRaw<{ id: number }[]>`
    SELECT id FROM orders WHERE order_number = ${orderNumber} FOR UPDATE`;
  const id = rows[0]?.id;
  return id === undefined ? null : tx.order.findUnique({ where: { id } });
}

export async function lockOrderById(
  tx: Prisma.TransactionClient,
  id: number,
): Promise<Order | null> {
  const rows = await tx.$queryRaw<{ id: number }[]>`
    SELECT id FROM orders WHERE id = ${id} FOR UPDATE`;
  return rows.length === 0 ? null : tx.order.findUnique({ where: { id } });
}

// Locks every order of one 1C number, in creation order.
export async function lockGroup(
  tx: Prisma.TransactionClient,
  baseNumber: string,
): Promise<Order[]> {
  await tx.$queryRaw`SELECT id FROM orders WHERE base_number = ${baseNumber} ORDER BY id FOR UPDATE`;
  return tx.order.findMany({ where: { baseNumber }, orderBy: { id: 'asc' } });
}

// Payments minus refunds across all orders of one 1C number.
export async function groupNetPaid(
  tx: Prisma.TransactionClient,
  baseNumber: string,
): Promise<Prisma.Decimal> {
  const where = { order: { baseNumber } };
  const [payments, refunds] = await Promise.all([
    tx.payment.aggregate({ where, _sum: { amount: true } }),
    tx.refund.aggregate({ where, _sum: { amount: true } }),
  ]);
  const zero = new Prisma.Decimal(0);
  return (payments._sum.amount ?? zero).minus(refunds._sum.amount ?? zero);
}

// Writes the group's shared status onto every live part; cancelled parts keep theirs.
export async function syncGroupStatus(
  tx: Prisma.TransactionClient,
  parts: Order[],
  paid: Prisma.Decimal,
): Promise<{ parts: Order[]; summary: GroupSummary }> {
  const summary = summarizeGroup(parts, paid);
  const synced: Order[] = [];
  for (const part of parts) {
    const stale = part.status !== OrderStatus.CANCELLED && part.status !== summary.status;
    synced.push(
      stale
        ? await tx.order.update({ where: { id: part.id }, data: { status: summary.status } })
        : part,
    );
  }
  return { parts: synced, summary };
}
