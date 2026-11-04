import {
  type Currency,
  type Manager,
  type Order,
  OrderType,
} from '../../../generated/prisma/client';
import { normalizeBaseNumber } from '../../orders/order-number';
import type { OrderWithManager, OrderWithPaid, OrdersService } from '../../orders/orders.service';
import type { RequisitesService } from '../../requisites/requisites.service';
import type { OrderRequisite } from '../../../generated/prisma/client';
import type { MinusPlan } from './minus-closing.parser';
import type { RequisitesPlan } from './requisites.parser';

/** What the bot flows and the Mini App completion share when they register orders. */
export interface OrderDeps {
  orders: OrdersService;
  requisites: RequisitesService;
}

type Author = Pick<Manager, 'id' | 'telegramId' | 'name'>;

/** Called as soon as the orders exist, before anything that can still fail. */
type OnCreated = (orders: Order[]) => void;

export type NumberCheck =
  | { ok: true; addPart: boolean; skipped: string[]; existing?: OrderWithPaid<OrderWithManager> }
  | { ok: false; reason: 'in-group'; number: string; groupNumber: string }
  | { ok: false; reason: 'other-currency'; number: string }
  | { ok: false; reason: 'all-taken'; skipped: string[] };

/** Which of the plan's numbers already exist: one number may take a part, several are skipped. */
export async function checkExistingNumbers(
  orders: Pick<OrdersService, 'findWithBalance'>,
  plan: { kind: 'single' | 'group'; currency: Currency; items: { number: string }[] },
): Promise<NumberCheck> {
  if (plan.kind === 'single') {
    const number = plan.items[0]!.number;
    const existing = await orders.findWithBalance(number);
    if (!existing) return { ok: true, addPart: false, skipped: [] };
    if (existing.order.orderNumber !== normalizeBaseNumber(number)) {
      return { ok: false, reason: 'in-group', number, groupNumber: existing.order.orderNumber };
    }
    if (existing.order.currency !== plan.currency) {
      return { ok: false, reason: 'other-currency', number };
    }
    return { ok: true, addPart: true, skipped: [], existing };
  }
  const found = await Promise.all(plan.items.map((item) => orders.findWithBalance(item.number)));
  const skipped = plan.items.filter((_, index) => found[index]).map((item) => item.number);
  if (skipped.length === plan.items.length) return { ok: false, reason: 'all-taken', skipped };
  return { ok: true, addPart: false, skipped };
}

export async function createRequisitesOrders(
  deps: OrderDeps,
  manager: Author,
  plan: RequisitesPlan,
  addPart: boolean,
  onCreated?: OnCreated,
): Promise<{ orders: Order[]; added: OrderRequisite[] }> {
  const common = {
    clientName: plan.label,
    currency: plan.currency,
    exchangeRate: plan.rate ?? undefined,
    comment: plan.comment ?? undefined,
  };

  let orders: Order[];
  if (plan.kind === 'group') {
    orders = await deps.orders.createGroup(
      manager.id,
      plan.items.map((item) => ({
        orderNumber: item.number,
        amountDue: item.amount.toFixed(2),
        clientName: item.fop ?? undefined,
        exchangeRate: item.rate ?? undefined,
      })),
      common,
    );
  } else {
    orders = [
      await deps.orders.create(
        manager.id,
        {
          ...common,
          orderType: OrderType.REGULAR,
          orderNumber: plan.items[0]?.number,
          amountDue: plan.total.toFixed(2),
        },
        { notify: false, addPart },
      ),
    ];
  }
  onCreated?.(orders);

  const added =
    plan.requisiteLines.length > 0
      ? await deps.requisites.addMany(orders[0]!.id, plan.requisiteLines, {
          telegramId: manager.telegramId,
          name: manager.name,
        })
      : [];
  return { orders, added };
}

export async function createMinusOrder(
  deps: OrderDeps,
  manager: Author,
  plan: MinusPlan,
  onCreated?: OnCreated,
): Promise<{ order: Order; added: OrderRequisite[] }> {
  const order = await deps.orders.create(
    manager.id,
    {
      orderType: OrderType.MINUS_CLOSING,
      clientName: plan.clientName,
      amountDue: plan.total.toFixed(2),
      currency: plan.currency,
      exchangeRate: plan.rate ?? undefined,
      comment: plan.comment ?? undefined,
      paidAt: plan.paidAt ?? undefined,
      ourFop: plan.ourFop ?? undefined,
      period: plan.period ?? undefined,
      sheetUrl: plan.sheetUrl ?? undefined,
    },
    { notify: false },
  );
  onCreated?.([order]);

  const added =
    plan.requisiteLines.length > 0
      ? await deps.requisites.addMany(order.id, plan.requisiteLines, {
          telegramId: manager.telegramId,
          name: manager.name,
        })
      : [];
  return { order, added };
}
