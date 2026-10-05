import { Injectable } from '@nestjs/common';
import {
  Currency,
  type Manager,
  type Order,
  OrderStatus,
  type Prisma,
} from '../../../generated/prisma/client';
import { OrdersService } from '../../orders/orders.service';
import { PaymentsService } from '../../payments/payments.service';

export interface ReportedItem {
  number: string;
  amount: Prisma.Decimal;
  paymentId: string;
}

export interface ReportedPayment {
  label: string;
  currency: Currency;
  items: ReportedItem[];
  existing: string[];
  paidAt: Date | null;
  payerName: string;
  receivingAccount: string;
  purpose: string;
  comment: string;
  exchangeRate?: string;
}

export type ReportCheck =
  | { ok: true; existing: string[] }
  | { ok: false; alreadyRecorded: true }
  | { ok: false; alreadyRecorded: false; errors: string[] };

@Injectable()
export class ReportedPaymentService {
  constructor(
    private readonly orders: OrdersService,
    private readonly payments: PaymentsService,
  ) {}

  async check(items: ReportedItem[], currency: Currency): Promise<ReportCheck> {
    const recorded = await Promise.all(
      items.map((item) => this.payments.findByExternalId(item.paymentId)),
    );
    if (recorded.every(Boolean)) {
      return { ok: false, alreadyRecorded: true };
    }

    const found = await Promise.all(items.map((item) => this.orders.findWithBalance(item.number)));
    const errors: string[] = [];
    const existing: string[] = [];
    items.forEach((item, index) => {
      const order = found[index]?.order;
      if (!order) {
        return;
      }
      if (order.status === OrderStatus.CANCELLED) {
        errors.push(`№ ${item.number} скасовано, оплату до нього не додати.`);
      } else if (order.currency !== currency) {
        errors.push(
          `№ ${item.number} ${order.currency === Currency.USD ? 'у доларах' : 'у гривнях'}, а оплата ${currency === Currency.USD ? 'в доларах' : 'в гривнях'}.`,
        );
      } else {
        existing.push(item.number);
      }
    });
    return errors.length > 0
      ? { ok: false, alreadyRecorded: false, errors }
      : { ok: true, existing };
  }

  async record(manager: Manager, report: ReportedPayment): Promise<Order | undefined> {
    const fresh = report.items.filter((item) => !report.existing.includes(item.number));
    const created =
      fresh.length > 0
        ? await this.orders.createGroup(
            manager.id,
            fresh.map((item) => ({
              orderNumber: item.number,
              amountDue: item.amount.toFixed(2),
            })),
            {
              clientName: report.label,
              currency: report.currency,
              exchangeRate: report.exchangeRate,
              paidAt: report.paidAt ?? undefined,
              comment: report.comment,
            },
          )
        : [];

    let paidOrder: Order | undefined;
    for (const item of report.items) {
      const result = await this.payments.ingest({
        external_transaction_id: item.paymentId,
        order_number: item.number,
        amount: item.amount.toFixed(2),
        currency: report.currency,
        payer_name: report.payerName,
        receiving_account: report.receivingAccount,
        purpose_text: report.purpose,
        paid_at: (report.paidAt ?? new Date()).toISOString(),
      });
      if (result.kind === 'recorded') {
        paidOrder ??= result.order;
      }
    }
    return created[0] ?? paidOrder;
  }
}
