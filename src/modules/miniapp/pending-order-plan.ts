import { Prisma } from '../../generated/prisma/client';
import type { CashPlan } from '../telegram/order-draft/cash.parser';
import type { ForeignPlan } from '../telegram/order-draft/foreign.parser';
import type { KitPlan } from '../telegram/order-draft/kit.parser';
import type { OrderPlan } from './miniapp.dto';

/** The plan as a JSON column: Decimal becomes a string and Date an ISO string on the way through JSON. */
export const toStoredPlan = (order: OrderPlan): Prisma.InputJsonValue =>
  JSON.parse(JSON.stringify(order)) as Prisma.InputJsonValue;

const decimal = (value: unknown): Prisma.Decimal => {
  if (typeof value !== 'string') throw new Error('not a decimal');
  return new Prisma.Decimal(value);
};

const date = (value: unknown): Date | null => {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') throw new Error('not a date');
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) throw new Error('not a date');
  return parsed;
};

/** The plan back from the column; null when the value is not one `toStoredPlan` could have written. */
export function fromStoredPlan(value: unknown): OrderPlan | null {
  if (typeof value !== 'object' || value === null) return null;
  const { kind, plan } = value as { kind?: unknown; plan?: Record<string, unknown> };
  if (typeof plan !== 'object' || plan === null) return null;
  try {
    switch (kind) {
      case 'kit':
        return {
          kind,
          plan: {
            ...(plan as object),
            total: decimal(plan.total),
            items: (plan.items as { number: string; amount: unknown }[]).map((item) => ({
              number: item.number,
              amount: decimal(item.amount),
            })),
            paidAt: date(plan.paidAt),
          } as KitPlan,
        };
      case 'cash':
        return {
          kind,
          plan: {
            ...(plan as object),
            amount: decimal(plan.amount),
            paidAt: date(plan.paidAt),
          } as CashPlan,
        };
      case 'foreign':
        return {
          kind,
          plan: {
            ...(plan as object),
            amount: decimal(plan.amount),
            paidAt: date(plan.paidAt),
          } as ForeignPlan,
        };
      default:
        return null;
    }
  } catch {
    return null;
  }
}
