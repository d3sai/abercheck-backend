import { toMeResponse, type MeResponse } from '../auth/dto/session.response';
import type {
  Manager,
  ManagerStatus,
  MatchType,
  OrderAttachment,
  OrderRequisite,
  OrderStatus,
  Payment,
  Prisma,
  Refund,
  RefundType,
} from '../../generated/prisma/client';
import type { OrderLedger, OrderWithManager, OrderWithPaid } from '../orders/orders.service';
import type { Activity, ActivityKind } from '../reports/activity.service';
import type { ReportBucket } from '../reports/daily-report.service';
import type { PeriodStats, Snapshot, Totals } from '../reports/stats.service';

const money = (value: Prisma.Decimal) => value.toFixed(2);

export interface Page<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

export interface TotalsView {
  count: number;
  amount: string;
}

export interface OrderSummaryView {
  id: number;
  orderNumber: string;
  clientName: string;
  amountDue: string;
  amountPaid: string;
  amountRemaining: string;
  status: OrderStatus;
  manager: { id: number; name: string };
  createdAt: string;
  updatedAt: string;
}

export interface PaymentView {
  id: number;
  externalTransactionId: string;
  amount: string;
  payerName: string | null;
  receivingAccount: string | null;
  purposeText: string | null;
  paidAt: string;
  reportedOrderNumber: string | null;
  matchType: MatchType;
  createdAt: string;
}

export interface RefundView {
  id: number;
  amount: string;
  type: RefundType;
  initiatedByName: string;
  note: string | null;
  createdAt: string;
}

export interface OrderAttachmentView {
  id: number;
  filename: string;
  mimeType: string;
  size: number;
  uploadedByName: string;
  createdAt: string;
}

// One individual payment behind an order paid via other people's requisites (a card, another FOP):
// who actually paid, through which account, how much and when.
export interface OrderRequisiteView {
  id: number;
  payerName: string;
  account: string | null;
  amount: string;
  paidAt: string;
  addedByName: string;
  createdAt: string;
}

export interface OrderGroupPartView {
  id: number;
  orderNumber: string;
  clientName: string;
  amountDue: string;
  status: OrderStatus;
}

// The whole 1C number this order belongs to: all its parts are paid by the same payment.
export interface OrderGroupView {
  baseNumber: string;
  amountDue: string;
  amountPaid: string;
  amountRemaining: string;
  status: OrderStatus;
  parts: OrderGroupPartView[];
}

export interface OrderDetailView extends OrderSummaryView {
  exchangeRate: string | null;
  comment: string | null;
  /** Minus closing only. */
  paidAt: string | null;
  ourFop: string | null;
  period: string | null;
  sheetUrl: string | null;
  group: OrderGroupView;
  payments: PaymentView[];
  refunds: RefundView[];
  attachments: OrderAttachmentView[];
  requisites: OrderRequisiteView[];
}

export interface ManagerView extends MeResponse {
  status: ManagerStatus;
  createdAt: string;
}

export interface SnapshotView {
  statusCounts: Record<OrderStatus, number>;
  outstanding: TotalsView;
  unmatched: TotalsView;
}

export interface PeriodView {
  from: string;
  to: string;
  payments: TotalsView;
  refunds: TotalsView;
  ordersCreated: TotalsView;
  byBucket: Record<ReportBucket, number>;
  daily: (TotalsView & { date: string })[];
  byManager: (TotalsView & { managerId: number; name: string })[];
}

export interface ActivityView {
  kind: ActivityKind;
  at: string;
  orderNumber: string | null;
  amount: string;
  status: OrderStatus | null;
  who: string | null;
}

export function toOrderSummary({
  order,
  amountPaid,
}: OrderWithPaid<OrderWithManager>): OrderSummaryView {
  return {
    id: order.id,
    orderNumber: order.orderNumber,
    clientName: order.clientName,
    amountDue: money(order.amountDue),
    amountPaid: money(amountPaid),
    amountRemaining: money(order.amountDue.minus(amountPaid)),
    status: order.status,
    manager: { id: order.manager.id, name: order.manager.name },
    createdAt: order.createdAt.toISOString(),
    updatedAt: order.updatedAt.toISOString(),
  };
}

export function toPaymentView(payment: Payment): PaymentView {
  return {
    id: payment.id,
    externalTransactionId: payment.externalTransactionId,
    amount: money(payment.amount),
    payerName: payment.payerName,
    receivingAccount: payment.receivingAccount,
    purposeText: payment.purposeText,
    paidAt: payment.paidAt.toISOString(),
    reportedOrderNumber: payment.reportedOrderNumber,
    matchType: payment.matchType,
    createdAt: payment.createdAt.toISOString(),
  };
}

export function toRefundView(refund: Refund): RefundView {
  return {
    id: refund.id,
    amount: money(refund.amount),
    type: refund.type,
    initiatedByName: refund.initiatedByName,
    note: refund.note,
    createdAt: refund.createdAt.toISOString(),
  };
}

export function toAttachmentView(attachment: OrderAttachment): OrderAttachmentView {
  return {
    id: attachment.id,
    filename: attachment.filename,
    mimeType: attachment.mimeType,
    size: attachment.size,
    uploadedByName: attachment.uploadedByName,
    createdAt: attachment.createdAt.toISOString(),
  };
}

export function toRequisiteView(requisite: OrderRequisite): OrderRequisiteView {
  return {
    id: requisite.id,
    payerName: requisite.payerName,
    account: requisite.account,
    amount: money(requisite.amount),
    paidAt: requisite.paidAt.toISOString(),
    addedByName: requisite.addedByName,
    createdAt: requisite.createdAt.toISOString(),
  };
}

export function toOrderDetail(
  ledger: OrderLedger,
  attachments: OrderAttachment[],
  requisites: OrderRequisite[],
): OrderDetailView {
  const { order } = ledger;
  return {
    ...toOrderSummary(ledger),
    exchangeRate: order.exchangeRate?.toFixed(4) ?? null,
    comment: order.comment,
    paidAt: order.paidAt?.toISOString() ?? null,
    ourFop: order.ourFop,
    period: order.period,
    sheetUrl: order.sheetUrl,
    group: {
      baseNumber: ledger.group.baseNumber,
      amountDue: money(ledger.group.amountDue),
      amountPaid: money(ledger.group.amountPaid),
      amountRemaining: money(ledger.group.amountDue.minus(ledger.group.amountPaid)),
      status: ledger.group.status,
      parts: ledger.group.parts.map((part) => ({
        id: part.id,
        orderNumber: part.orderNumber,
        clientName: part.clientName,
        amountDue: money(part.amountDue),
        status: part.status,
      })),
    },
    payments: ledger.payments.map(toPaymentView),
    refunds: ledger.refunds.map(toRefundView),
    attachments: attachments.map(toAttachmentView),
    requisites: requisites.map(toRequisiteView),
  };
}

export function toManagerView(manager: Manager): ManagerView {
  return {
    ...toMeResponse(manager),
    status: manager.status,
    createdAt: manager.createdAt.toISOString(),
  };
}

const totals = ({ count, amount }: Totals): TotalsView => ({ count, amount: money(amount) });

export function toSnapshotView(snapshot: Snapshot): SnapshotView {
  return {
    statusCounts: snapshot.statusCounts,
    outstanding: totals(snapshot.outstanding),
    unmatched: totals(snapshot.unmatched),
  };
}

export function toPeriodView(from: string, to: string, stats: PeriodStats): PeriodView {
  return {
    from,
    to,
    payments: totals(stats.payments),
    refunds: totals(stats.refunds),
    ordersCreated: totals(stats.ordersCreated),
    byBucket: stats.byBucket,
    daily: stats.daily.map((day) => ({ date: day.date, ...totals(day) })),
    byManager: stats.byManager.map((row) => ({
      managerId: row.managerId,
      name: row.name,
      ...totals(row),
    })),
  };
}

export function toActivityView(activity: Activity): ActivityView {
  return {
    kind: activity.kind,
    at: activity.at.toISOString(),
    orderNumber: activity.orderNumber,
    amount: money(activity.amount),
    status: activity.status,
    who: activity.who,
  };
}
