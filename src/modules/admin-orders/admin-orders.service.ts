import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import { AttachmentsService } from '../attachments/attachments.service';
import {
  groupNetPaid,
  lockGroup,
  resolveBaseNumber,
  syncGroupStatus,
} from '../orders/order-ledger';
import { normalizePartNumber } from '../orders/order-number';
import { AdminOrdersErrors } from './admin-orders.errors';
import type { DeleteOrderDto } from './dto/delete-order.dto';
import type { DeleteResultResponse, OrderPreviewResponse } from './dto/order-preview.response';

@Injectable()
export class AdminOrdersService {
  private readonly logger = new Logger(AdminOrdersService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly attachments: AttachmentsService,
  ) {}

  async preview(rawNumber: string): Promise<OrderPreviewResponse> {
    const orderNumber = normalizePartNumber(rawNumber);
    const order = await this.prisma.order.findUnique({
      where: { orderNumber },
      include: {
        manager: true,
        payments: { select: { amount: true } },
        _count: {
          select: { refunds: true, paymentDetails: true, amountChanges: true, attachments: true },
        },
      },
    });
    if (!order) {
      throw AdminOrdersErrors.notFound(orderNumber);
    }
    const siblings = await this.prisma.order.findMany({
      where: { baseNumber: order.baseNumber, id: { not: order.id } },
      orderBy: { id: 'asc' },
    });

    return {
      order_number: order.orderNumber,
      base_number: order.baseNumber,
      client_name: order.clientName,
      amount_due: order.amountDue.toFixed(2),
      currency: order.currency,
      status: order.status,
      manager_name: order.manager.name,
      created_at: order.createdAt.toISOString(),
      payments_count: order.payments.length,
      payments_total: order.payments
        .reduce((sum, payment) => sum.plus(payment.amount), new Prisma.Decimal(0))
        .toFixed(2),
      refunds_count: order._count.refunds,
      requisites_count: order._count.paymentDetails,
      amount_changes_count: order._count.amountChanges,
      attachments_count: order._count.attachments,
      sibling_parts: siblings.map((part) => ({
        order_number: part.orderNumber,
        amount_due: part.amountDue.toFixed(2),
        status: part.status,
      })),
    };
  }

  async remove(
    rawNumber: string,
    dto: DeleteOrderDto,
    actor: string,
  ): Promise<DeleteResultResponse> {
    const orderNumber = normalizePartNumber(rawNumber);
    if (dto.confirm !== orderNumber) {
      throw AdminOrdersErrors.confirmMismatch();
    }

    const { result, files, snapshot } = await this.prisma.$transaction(async (tx) => {
      const parts = await lockGroup(tx, await resolveBaseNumber(tx, orderNumber));
      const target = parts.find((part) => part.orderNumber === orderNumber);
      if (!target) {
        throw AdminOrdersErrors.notFound(orderNumber);
      }
      const where = { orderId: target.id };

      const files = await tx.orderAttachment.findMany({ where });
      const refunds = await tx.refund.deleteMany({ where });
      const requisites = await tx.orderRequisite.deleteMany({ where });
      const amountChanges = await tx.orderAmountChange.deleteMany({ where });
      const attachments = await tx.orderAttachment.deleteMany({ where });
      const detach = dto.payments === 'detach';
      const payments = detach
        ? await tx.payment.updateMany({ where, data: { orderId: null } })
        : await tx.payment.deleteMany({ where });
      await tx.order.delete({ where: { id: target.id } });

      const remaining = parts.filter((part) => part.id !== target.id);
      if (remaining.length > 0) {
        await syncGroupStatus(tx, remaining, await groupNetPaid(tx, target.baseNumber));
      }

      const result: DeleteResultResponse = {
        order_number: target.orderNumber,
        payments_detached: detach ? payments.count : 0,
        payments_deleted: detach ? 0 : payments.count,
        refunds_deleted: refunds.count,
        requisites_deleted: requisites.count,
        amount_changes_deleted: amountChanges.count,
        attachments_deleted: attachments.count,
      };
      const snapshot = {
        orderNumber: target.orderNumber,
        client: target.clientName,
        amountDue: target.amountDue.toFixed(2),
        currency: target.currency,
        status: target.status,
      };
      return { result, files, snapshot };
    });

    await Promise.allSettled(files.map((file) => this.attachments.discardMessage(file)));
    this.logger.log(`Order deleted ${JSON.stringify({ ...snapshot, ...result, actor })}`);
    return result;
  }
}
