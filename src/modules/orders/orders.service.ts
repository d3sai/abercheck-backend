import { Injectable } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import {
  Currency,
  type Manager,
  type Order,
  OrderType,
  type OrderStatus,
  type Payment,
  Prisma,
  type Refund,
} from '../../generated/prisma/client';
import { isRecordNotFound, isUniqueViolation } from '../../common/prisma/prisma-errors';
import { PrismaService } from '../../common/prisma/prisma.service';
import type { Initiator } from '../refunds/refund.events';
import type { CreateOrderDto } from './dto/create-order.dto';
import type { UpdateOrderDto } from './dto/update-order.dto';
import { allocateShares, liveParts, nextPartIndex, rollUp } from './order-group';
import {
  groupNetPaid,
  lockGroup,
  lockOrderByNumber,
  resolveBaseNumber,
  syncGroupStatus,
} from './order-ledger';
import {
  baseNumberOf,
  generateClosingOrderNumber,
  normalizeBaseNumber,
  normalizePartNumber,
  partNumber,
} from './order-number';
import { type OrderCreated, OrderEvents } from './order.events';
import { UNPAID_STATUSES } from './order-status';
import {
  OrderCurrencyMismatchError,
  OrderNotFoundError,
  OrderNumberTakenError,
} from './orders.errors';

export interface OrderFilter {
  managerId?: number;
  statuses?: OrderStatus[];
}

export interface OrderWithPaid<T extends Order = Order> {
  order: T;
  amountPaid: Prisma.Decimal;
  // Set for a whole number: every number of the group that is still alive.
  orderNumbers?: string[];
}

export interface GroupOrderItem {
  orderNumber: string;
  amountDue: string;
}

export type OrderWithManager = Order & { manager: Manager };

export type OrderSort = 'createdAt' | 'amountDue' | 'orderNumber';

export interface OrderSearch extends OrderFilter {
  text?: string;
  sort: OrderSort;
  direction: Prisma.SortOrder;
  skip: number;
  take: number;
}

export interface OrderGroupView {
  baseNumber: string;
  amountDue: Prisma.Decimal;
  amountPaid: Prisma.Decimal;
  status: OrderStatus;
  parts: OrderWithManager[];
}

// Filled only by the bot's minus-closing flow — deliberately not part of the public CreateOrderDto.
export interface ClosingDetails {
  paidAt?: Date;
  ourFop?: string;
  period?: string;
  sheetUrl?: string;
}

export interface OrderLedger extends OrderWithPaid<OrderWithManager> {
  payments: Payment[];
  refunds: Refund[];
  group: OrderGroupView;
}

interface LoadedGroup {
  parts: OrderWithManager[];
  paid: Prisma.Decimal;
}

function orderBy(sort: OrderSort, direction: Prisma.SortOrder) {
  switch (sort) {
    case 'amountDue':
      return [{ amountDue: direction }, { id: direction }];
    case 'orderNumber':
      return [{ orderNumber: direction }];
    case 'createdAt':
      return [{ createdAt: direction }, { id: direction }];
  }
}

@Injectable()
export class OrdersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly events: EventEmitter2,
  ) {}

  // Creating an order on a number that is already taken is refused, unless the caller asks for
  // another part of that number: it then gets the next "(n)" suffix and joins the group.
  async create(
    managerId: number,
    dto: CreateOrderDto & ClosingDetails,
    options?: { notify?: boolean; addPart?: boolean },
  ): Promise<Order> {
    const baseNumber = dto.orderNumber
      ? normalizeBaseNumber(dto.orderNumber)
      : generateClosingOrderNumber();
    let order: Order;
    try {
      order = await this.prisma.$transaction(async (tx) => {
        const parts = await lockGroup(tx, baseNumber);
        if (parts.length > 0 && !options?.addPart) {
          throw new OrderNumberTakenError(baseNumber);
        }
        if (parts.some((part) => part.currency !== (dto.currency ?? Currency.UAH))) {
          throw new OrderCurrencyMismatchError(baseNumber);
        }
        const orderNumber = partNumber(baseNumber, nextPartIndex(parts));
        const created = await tx.order.create({
          data: { ...dto, orderNumber, baseNumber, managerId },
        });
        if (parts.length === 0) {
          return created;
        }
        const paid = await groupNetPaid(tx, baseNumber);
        const synced = await syncGroupStatus(tx, [...parts, created], paid);
        return synced.parts[synced.parts.length - 1]!;
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new OrderNumberTakenError(baseNumber);
      }
      throw error;
    }
    if (options?.notify ?? true) {
      this.events.emit(OrderEvents.Created, { order } satisfies OrderCreated);
    }
    return order;
  }

  // Several different 1C numbers paid by one payment: each keeps its own number and amount, but
  // they form one group under the first number, so a payment, a status and a refund cover them all.
  async createGroup(
    managerId: number,
    items: GroupOrderItem[],
    common: { clientName: string; currency?: Currency; exchangeRate?: string; comment?: string },
    options?: { notify?: boolean },
  ): Promise<Order[]> {
    const numbers = items.map((item) => baseNumberOf(normalizeBaseNumber(item.orderNumber)));
    const baseNumber = numbers[0];
    if (baseNumber === undefined || new Set(numbers).size !== numbers.length) {
      throw new OrderNumberTakenError(baseNumber ?? '');
    }

    let orders: Order[];
    try {
      orders = await this.prisma.$transaction(async (tx) => {
        const taken = await tx.order.findMany({
          where: { OR: [{ orderNumber: { in: numbers } }, { baseNumber: { in: numbers } }] },
          select: { orderNumber: true },
        });
        if (taken.length > 0) {
          throw new OrderNumberTakenError(taken[0]!.orderNumber);
        }
        const created: Order[] = [];
        for (const [index, item] of items.entries()) {
          created.push(
            await tx.order.create({
              data: {
                orderType: OrderType.REGULAR,
                orderNumber: numbers[index]!,
                baseNumber,
                clientName: common.clientName,
                amountDue: item.amountDue,
                currency: common.currency,
                exchangeRate: common.exchangeRate,
                comment: index === 0 ? common.comment : `Оплата разом із № ${baseNumber}`,
                managerId,
              },
            }),
          );
        }
        return created;
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new OrderNumberTakenError(baseNumber);
      }
      throw error;
    }
    if (options?.notify ?? false) {
      for (const order of orders) {
        this.events.emit(OrderEvents.Created, { order } satisfies OrderCreated);
      }
    }
    return orders;
  }

  // One entry per 1C number: an unpaid number is listed once, with the total of all its parts.
  async findUnpaid(
    limit: number,
    cursor?: number,
  ): Promise<{ items: OrderWithPaid[]; nextCursor: number | null }> {
    const heads = await this.prisma.order.groupBy({
      by: ['baseNumber'],
      where: { status: { in: UNPAID_STATUSES } },
      _min: { id: true },
      having: cursor === undefined ? undefined : { id: { _min: { gt: cursor } } },
      orderBy: { _min: { id: 'asc' } },
      take: limit + 1,
    });

    const hasMore = heads.length > limit;
    const page = hasMore ? heads.slice(0, limit) : heads;
    const nextCursor = hasMore ? (page[page.length - 1]!._min.id ?? null) : null;
    return { items: await this.groupsWithBalance(page.map((head) => head.baseNumber)), nextCursor };
  }

  // The whole number as one record: total due, everything paid against it. Any number of a group
  // finds the group.
  async findWithBalance(orderNumber: string): Promise<OrderWithPaid<OrderWithManager> | null> {
    const [group] = await this.groupsWithBalance([
      await resolveBaseNumber(this.prisma, orderNumber),
    ]);
    return group ?? null;
  }

  async findWithBalanceById(id: number): Promise<OrderWithPaid<OrderWithManager> | null> {
    const order = await this.prisma.order.findUnique({
      where: { id },
      select: { baseNumber: true },
    });
    if (!order) {
      return null;
    }
    const [group] = await this.groupsWithBalance([order.baseNumber]);
    return group ?? null;
  }

  async findGroupsByOrderIds(ids: number[]): Promise<OrderWithPaid<OrderWithManager>[]> {
    if (ids.length === 0) {
      return [];
    }
    const orders = await this.prisma.order.findMany({
      where: { id: { in: ids } },
      select: { baseNumber: true },
      orderBy: { id: 'asc' },
    });
    return this.groupsWithBalance([...new Set(orders.map((order) => order.baseNumber))]);
  }

  async list(
    { managerId, statuses }: OrderFilter,
    limit: number,
  ): Promise<{ items: OrderWithPaid<OrderWithManager>[]; total: number }> {
    const where = { managerId, status: statuses ? { in: statuses } : undefined };
    const [orders, total] = await Promise.all([
      this.prisma.order.findMany({
        where,
        include: { manager: true },
        orderBy: { createdAt: 'desc' },
        take: limit,
      }),
      this.prisma.order.count({ where }),
    ]);
    return { items: await this.withBalances(orders), total };
  }

  async search({
    managerId,
    statuses,
    text,
    sort,
    direction,
    skip,
    take,
  }: OrderSearch): Promise<{ items: OrderWithPaid<OrderWithManager>[]; total: number }> {
    const where: Prisma.OrderWhereInput = {
      managerId,
      status: statuses?.length ? { in: statuses } : undefined,
      OR: text
        ? [
            { orderNumber: { contains: text, mode: 'insensitive' } },
            { clientName: { contains: text, mode: 'insensitive' } },
          ]
        : undefined,
    };
    const [orders, total] = await Promise.all([
      this.prisma.order.findMany({
        where,
        include: { manager: true },
        orderBy: orderBy(sort, direction),
        skip,
        take,
      }),
      this.prisma.order.count({ where }),
    ]);
    return { items: await this.withBalances(orders), total };
  }

  // A single order (part) of a number; payments and refunds are those of the whole number.
  async findLedger(orderNumber: string): Promise<OrderLedger | null> {
    const order = await this.prisma.order.findUnique({
      where: { orderNumber: normalizePartNumber(orderNumber) },
      select: { baseNumber: true },
    });
    if (!order) {
      return null;
    }
    const { baseNumber } = order;
    const [groups, payments, refunds] = await Promise.all([
      this.loadGroups([baseNumber]),
      this.prisma.payment.findMany({
        where: { order: { baseNumber } },
        orderBy: [{ paidAt: 'asc' }, { id: 'asc' }],
      }),
      this.prisma.refund.findMany({
        where: { order: { baseNumber } },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      }),
    ]);
    const group = groups.get(baseNumber);
    const part = group?.parts.find((p) => p.orderNumber === normalizePartNumber(orderNumber));
    if (!group || !part) {
      return null;
    }
    const rolled = rollUp(group.parts);
    return {
      order: part,
      amountPaid: allocateShares(group.parts, group.paid).get(part.id) ?? new Prisma.Decimal(0),
      payments,
      refunds,
      group: {
        baseNumber,
        amountDue: rolled.amountDue,
        amountPaid: group.paid,
        status: rolled.status,
        parts: group.parts,
      },
    };
  }

  async update(orderNumber: string, dto: UpdateOrderDto, initiator: Initiator): Promise<Order> {
    const { amountDue } = dto;
    if (amountDue === undefined) {
      try {
        return await this.prisma.order.update({ where: { orderNumber }, data: dto });
      } catch (error) {
        if (isRecordNotFound(error)) {
          throw new OrderNotFoundError(orderNumber);
        }
        throw error;
      }
    }

    return this.prisma.$transaction(async (tx) => {
      const order = await lockOrderByNumber(tx, orderNumber);
      if (!order) {
        throw new OrderNotFoundError(orderNumber);
      }
      const parts = await lockGroup(tx, order.baseNumber);

      const newAmountDue = new Prisma.Decimal(amountDue);
      await tx.orderAmountChange.create({
        data: {
          orderId: order.id,
          previousAmountDue: order.amountDue,
          newAmountDue,
          changedByTelegramId: initiator.telegramId,
          changedByName: initiator.name,
        },
      });

      const updated = await tx.order.update({
        where: { id: order.id },
        data: { ...dto, amountDue: newAmountDue },
      });
      const paid = await groupNetPaid(tx, order.baseNumber);
      const synced = await syncGroupStatus(
        tx,
        parts.map((part) => (part.id === updated.id ? updated : part)),
        paid,
      );
      return synced.parts.find((part) => part.id === updated.id) ?? updated;
    });
  }

  private async loadGroups(baseNumbers: string[]): Promise<Map<string, LoadedGroup>> {
    const parts = await this.prisma.order.findMany({
      where: { baseNumber: { in: baseNumbers } },
      include: { manager: true },
      orderBy: { id: 'asc' },
    });
    const where = { orderId: { in: parts.map((part) => part.id) } };
    const [payments, refunds] = await Promise.all([
      this.prisma.payment.groupBy({ by: ['orderId'], where, _sum: { amount: true } }),
      this.prisma.refund.groupBy({ by: ['orderId'], where, _sum: { amount: true } }),
    ]);

    const zero = new Prisma.Decimal(0);
    const paid = new Map(payments.map((sum) => [sum.orderId, sum._sum.amount ?? zero]));
    const refunded = new Map(refunds.map((sum) => [sum.orderId, sum._sum.amount ?? zero]));

    const groups = new Map<string, LoadedGroup>();
    for (const part of parts) {
      const group = groups.get(part.baseNumber) ?? { parts: [], paid: zero };
      group.parts.push(part);
      group.paid = group.paid.plus(paid.get(part.id) ?? zero).minus(refunded.get(part.id) ?? zero);
      groups.set(part.baseNumber, group);
    }
    return groups;
  }

  private async groupsWithBalance(
    baseNumbers: string[],
  ): Promise<OrderWithPaid<OrderWithManager>[]> {
    if (baseNumbers.length === 0) {
      return [];
    }
    const groups = await this.loadGroups(baseNumbers);
    return baseNumbers.flatMap((baseNumber) => {
      const group = groups.get(baseNumber);
      return group
        ? [
            {
              order: rollUp(group.parts),
              amountPaid: group.paid,
              orderNumbers: liveParts(group.parts).map((part) => part.orderNumber),
            },
          ]
        : [];
    });
  }

  // Each order shows its own share of what was paid against its number.
  private async withBalances<T extends Order>(orders: T[]): Promise<OrderWithPaid<T>[]> {
    if (orders.length === 0) {
      return [];
    }
    const groups = await this.loadGroups([...new Set(orders.map((order) => order.baseNumber))]);
    const zero = new Prisma.Decimal(0);
    const shares = new Map<string, Map<number, Prisma.Decimal>>();
    return orders.map((order) => {
      let byOrder = shares.get(order.baseNumber);
      if (!byOrder) {
        const group = groups.get(order.baseNumber);
        byOrder = group ? allocateShares(group.parts, group.paid) : new Map();
        shares.set(order.baseNumber, byOrder);
      }
      return { order, amountPaid: byOrder.get(order.id) ?? zero };
    });
  }
}
