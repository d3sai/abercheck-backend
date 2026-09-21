import { Injectable } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { MatchType, type Order, type Payment, Prisma } from '../../generated/prisma/client';
import { liveParts, pickAnchor, rollUp } from '../orders/order-group';
import { groupNetPaid, lockGroup, syncGroupStatus } from '../orders/order-ledger';
import { normalizeBaseNumber } from '../orders/order-number';
import { OrderCancelledError, OrderNotFoundError } from '../orders/orders.errors';
import { isUniqueViolation } from '../../common/prisma/prisma-errors';
import { PrismaService } from '../../common/prisma/prisma.service';
import type { CreatePaymentDto } from './dto/create-payment.dto';
import {
  type IngestionResult,
  PaymentEvents,
  type PaymentRecorded,
  type PaymentUnmatched,
} from './payment-ingestion.types';
import { PaymentAlreadyAttachedError, PaymentNotFoundError } from './payments.errors';

const AMOUNT_QUERY = /^\d{1,12}([.,]\d{1,2})?$/;

@Injectable()
export class PaymentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly events: EventEmitter2,
  ) {}

  async ingest(dto: CreatePaymentDto): Promise<IngestionResult> {
    const existing = await this.findByExternalId(dto.external_transaction_id);
    if (existing) {
      return { kind: 'duplicate', payment: existing };
    }

    let result: PaymentRecorded | PaymentUnmatched;
    try {
      result = await this.prisma.$transaction((tx) => this.record(tx, dto));
    } catch (error) {
      const duplicate = isUniqueViolation(error)
        ? await this.findByExternalId(dto.external_transaction_id)
        : null;
      if (!duplicate) {
        throw error;
      }
      return { kind: 'duplicate', payment: duplicate };
    }

    this.events.emit(
      result.kind === 'recorded' ? PaymentEvents.Recorded : PaymentEvents.Unmatched,
      result,
    );
    return result;
  }

  async attach(paymentId: number, orderNumber: string): Promise<PaymentRecorded> {
    const result = await this.prisma.$transaction(async (tx) => {
      const locked = await tx.$queryRaw<{ id: number }[]>`
        SELECT id FROM payments WHERE id = ${paymentId} FOR UPDATE`;
      const payment =
        locked.length > 0 ? await tx.payment.findUnique({ where: { id: paymentId } }) : null;
      if (!payment) {
        throw new PaymentNotFoundError(paymentId);
      }
      if (payment.orderId !== null) {
        throw new PaymentAlreadyAttachedError(paymentId);
      }

      const number = normalizeBaseNumber(orderNumber);
      const parts = await lockGroup(tx, number);
      if (parts.length === 0) {
        throw new OrderNotFoundError(number);
      }
      if (liveParts(parts).length === 0) {
        throw new OrderCancelledError(number);
      }

      const attached = await tx.payment.update({
        where: { id: paymentId },
        data: { orderId: pickAnchor(parts).id },
      });
      return this.applyToGroup(tx, attached, parts);
    });

    this.events.emit(PaymentEvents.Recorded, result);
    return result;
  }

  findById(id: number): Promise<Payment | null> {
    return this.prisma.payment.findUnique({ where: { id } });
  }

  async findUnmatched(limit: number): Promise<{ payments: Payment[]; total: number }> {
    const where = { orderId: null };
    const [payments, total] = await Promise.all([
      this.prisma.payment.findMany({ where, orderBy: { paidAt: 'desc' }, take: limit }),
      this.prisma.payment.count({ where }),
    ]);
    return { payments, total };
  }

  async findUnmatchedPage({
    text,
    skip,
    take,
  }: {
    text?: string;
    skip: number;
    take: number;
  }): Promise<{ payments: Payment[]; total: number }> {
    const amount = text && AMOUNT_QUERY.test(text) ? text.replace(',', '.') : null;
    const where: Prisma.PaymentWhereInput = {
      orderId: null,
      OR: text
        ? [
            { payerName: { contains: text, mode: 'insensitive' } },
            { purposeText: { contains: text, mode: 'insensitive' } },
            { reportedOrderNumber: { contains: text } },
            ...(amount ? [{ amount: new Prisma.Decimal(amount) }] : []),
          ]
        : undefined,
    };
    const [payments, total] = await Promise.all([
      this.prisma.payment.findMany({
        where,
        orderBy: [{ paidAt: 'desc' }, { id: 'desc' }],
        skip,
        take,
      }),
      this.prisma.payment.count({ where }),
    ]);
    return { payments, total };
  }

  private async record(
    tx: Prisma.TransactionClient,
    dto: CreatePaymentDto,
  ): Promise<PaymentRecorded | PaymentUnmatched> {
    const reportedOrderNumber = dto.order_number ?? null;
    const parts = reportedOrderNumber
      ? await lockGroup(tx, normalizeBaseNumber(reportedOrderNumber))
      : [];
    const anchor = parts.length > 0 ? pickAnchor(parts) : null;

    const payment = await tx.payment.create({
      data: {
        externalTransactionId: dto.external_transaction_id,
        amount: dto.amount,
        payerName: dto.payer_name,
        receivingAccount: dto.receiving_account,
        purposeText: dto.purpose_text,
        paidAt: new Date(dto.paid_at),
        reportedOrderNumber,
        orderId: anchor?.id ?? null,
        matchType: anchor ? MatchType.MATCHED_BY_PROVIDER : MatchType.MANUAL,
      },
    });
    return anchor ? this.applyToGroup(tx, payment, parts) : { kind: 'unmatched', payment };
  }

  // A payment covers the whole 1C number: all its orders share the resulting status.
  private async applyToGroup(
    tx: Prisma.TransactionClient,
    payment: Payment,
    parts: Order[],
  ): Promise<PaymentRecorded> {
    const amountPaid = await groupNetPaid(tx, pickAnchor(parts).baseNumber);
    const previousStatus = pickAnchor(parts).status;
    const synced = await syncGroupStatus(tx, parts, amountPaid);

    return {
      kind: 'recorded',
      payment,
      order: rollUp(synced.parts),
      previousStatus,
      amountPaid,
    };
  }

  private findByExternalId(externalTransactionId: string): Promise<Payment | null> {
    return this.prisma.payment.findUnique({ where: { externalTransactionId } });
  }
}
