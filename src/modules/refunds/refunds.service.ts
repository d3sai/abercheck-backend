import { Injectable } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { type Order, OrderStatus, Prisma, RefundType } from '../../generated/prisma/client';
import { liveParts, pickAnchor, rollUp } from '../orders/order-group';
import { groupNetPaid, lockGroup, lockOrderById, syncGroupStatus } from '../orders/order-ledger';
import { OrderCancelledError, OrderNotFoundError } from '../orders/orders.errors';
import { PrismaService } from '../../common/prisma/prisma.service';
import {
  type Initiator,
  type OrderCancelled,
  RefundEvents,
  type RefundRecorded,
} from './refund.events';
import { NothingToRefundError, OrderHasPaymentsError, RefundAmountError } from './refunds.errors';

@Injectable()
export class RefundsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly events: EventEmitter2,
  ) {}

  async refund(
    orderId: number,
    amount: string | null,
    initiator: Initiator,
  ): Promise<RefundRecorded> {
    const result = await this.prisma.$transaction(async (tx) => {
      const order = await this.lock(tx, orderId);
      const parts = await lockGroup(tx, order.baseNumber);
      const paid = await groupNetPaid(tx, order.baseNumber);
      if (!paid.greaterThan(0)) {
        throw new NothingToRefundError(order.baseNumber);
      }

      const value = amount === null ? paid : new Prisma.Decimal(amount);
      if (!value.greaterThan(0) || value.greaterThan(paid)) {
        throw new RefundAmountError(order.baseNumber, paid);
      }

      const remaining = paid.minus(value);
      const type = remaining.isZero() ? RefundType.FULL : RefundType.PARTIAL;
      const anchor = pickAnchor(parts);
      const refund = await tx.refund.create({
        data: {
          orderId: anchor.id,
          amount: value,
          type,
          initiatedByTelegramId: initiator.telegramId,
          initiatedByName: initiator.name,
        },
      });

      const updated =
        type === RefundType.FULL
          ? await this.cancel(tx, liveParts(parts), parts)
          : (await syncGroupStatus(tx, parts, remaining)).parts;

      return {
        refund,
        order: rollUp(updated),
        previousStatus: anchor.status,
        amountPaid: remaining,
      };
    });

    this.events.emit(RefundEvents.Recorded, result);
    return result;
  }

  // Cancels one order, or with wholeNumber every order of its 1C number.
  async cancelUnpaid(
    orderId: number,
    initiator: Initiator,
    options?: { wholeNumber?: boolean },
  ): Promise<OrderCancelled> {
    const result = await this.prisma.$transaction(async (tx) => {
      const order = await this.lock(tx, orderId);
      if (order.status === OrderStatus.CANCELLED) {
        throw new OrderCancelledError(order.orderNumber);
      }
      const parts = await lockGroup(tx, order.baseNumber);
      const paid = await groupNetPaid(tx, order.baseNumber);
      if (!paid.isZero()) {
        throw new OrderHasPaymentsError(order.baseNumber, paid);
      }

      const targets = options?.wholeNumber ? liveParts(parts) : [order];
      const updated = await this.cancel(tx, targets, parts);
      return {
        order: options?.wholeNumber ? rollUp(updated) : updated.find((p) => p.id === order.id)!,
        previousStatus: order.status,
        initiator,
      };
    });

    this.events.emit(RefundEvents.OrderCancelled, result);
    return result;
  }

  private async cancel(
    tx: Prisma.TransactionClient,
    targets: Order[],
    parts: Order[],
  ): Promise<Order[]> {
    const ids = new Set(targets.map((part) => part.id));
    const updated: Order[] = [];
    for (const part of parts) {
      updated.push(
        ids.has(part.id)
          ? await tx.order.update({
              where: { id: part.id },
              data: { status: OrderStatus.CANCELLED },
            })
          : part,
      );
    }
    return updated;
  }

  private async lock(tx: Prisma.TransactionClient, orderId: number): Promise<Order> {
    const order = await lockOrderById(tx, orderId);
    if (!order) {
      throw new OrderNotFoundError(`#${orderId}`);
    }
    return order;
  }
}
