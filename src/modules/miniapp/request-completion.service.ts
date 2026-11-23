import { adminOrderCreatedMessage } from '../telegram/notifications/order-templates';
import { TELEGRAM_CAPTION_LIMIT } from '../attachments/attachments.constants';
import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { ApiError, type ApiErrorBody } from '../../common/api-error';
import {
  Currency,
  type FinanceRequestCard,
  type Manager,
  type Order,
  OrderType,
  Prisma,
} from '../../generated/prisma/client';
import { AttachmentsService } from '../attachments/attachments.service';
import { initiatorOf } from '../cabinet/cabinet-access';
import { FinanceClient } from '../finance-sync/finance.client';
import {
  type FinanceRequestView,
  paysAfterConfirm,
  type RequestKind,
} from '../finance-sync/finance.types';
import {
  paymentReportMessage,
  type ReportedPayment,
  UNNAMED_PAYER,
} from '../finance-sync/payment-report';
import { managerCard } from '../finance-sync/request-card.messages';
import { RequestCardsRepository } from '../finance-sync/request-cards.repository';
import { RequestReceiptsService } from '../finance-sync/request-receipts.service';
import { storedPayments } from '../finance-sync/stored-payments';
import { OrderNumberTakenError } from '../orders/orders.errors';
import { type OrderWithManager, type OrderWithPaid, OrdersService } from '../orders/orders.service';
import { RequisitesService } from '../requisites/requisites.service';
import { TelegramSender } from '../telegram/core/telegram-sender';
import {
  checkExistingNumbers,
  createMinusOrder,
  createRequisitesOrders,
  type NumberCheck,
} from '../telegram/order-draft/draft-orders';
import { adminMinusMessage } from '../telegram/order-draft/minus-closing.messages';
import { adminRequisitesMessage } from '../telegram/order-draft/requisites.messages';
import type { PlanItem, RequisitesPlan } from '../telegram/order-draft/requisites.parser';
import {
  type AddPaymentsMiniappDto,
  type CompleteMiniappRequestDto,
  fromStored,
  type PaidMiniappRequestDto,
  type Payment,
  toOrderOverrides,
  toPaidAt,
  toPayments,
} from './miniapp.dto';
import { financeError, notFound } from './miniapp.errors';

export interface CompletionResult {
  orderNumbers: string[];
  skipped: string[];
  /** Set when the orders exist but a later step did not go through. */
  note?: string;
}

interface Made {
  orders: Order[];
  skipped: string[];
  /** The admin notice that still has to go out; our_fop's and foreign_fop's go out through the order events. */
  notice: string | null;
  /** our_fop, foreign_fop: the payments given in the form, reported in reply to the notice. */
  report?: string | null;
}

/** What the creators report while they work, so a failure after the orders exist loses nothing. */
interface LiveItems {
  items: PlanItem[];
  skipped: string[];
  addPart: boolean;
}

interface Progress {
  created: Order[];
  skipped: string[];
  /** The admin notice without payer rows, for when the requisites write fails. */
  fallbackNotice: ((orders: Order[]) => string) | null;
  /** Receipts wait for the orders: the order notice then goes as their caption, not on its own. */
  heldReceipts: boolean;
}

const ORDER_KINDS = ['our_fop', 'foreign_fop', 'card'];

/** What `finish` needs, whichever way the manager got here: the form or «✅ Прийняти». */
interface Completion {
  payments: (kind: RequestKind, card: FinanceRequestCard) => Payment[];
  orders?: CompleteMiniappRequestDto['orders'];
  comment?: string | null;
  addPart: boolean;
}

const PARTIAL_NOTE =
  'Замовлення створено, але реквізити платежів не збережено — перевірте їх у кабінеті.';

const RECEIPTS_NOTE = 'Квитанції не додано — надішліть їх ще раз відповіддю на картку.';

const apiError = (status: HttpStatus, code: string, message: string): ApiError =>
  new ApiError(status, code, message);

const numberTaken = (check: Exclude<NumberCheck, { ok: true }>): ApiError =>
  apiError(
    HttpStatus.CONFLICT,
    'order-taken',
    check.reason === 'all-taken'
      ? `Усі ці номери вже є в системі: ${check.skipped.join(', ')}.`
      : check.reason === 'in-group'
        ? `Номер ${check.number} уже є в системі у складі № ${check.groupNumber}.`
        : `Номер ${check.number} уже є в системі в іншій валюті.`,
  );

const partOffer = ({ order, amountPaid }: OrderWithPaid<OrderWithManager>): ApiError =>
  new ApiError(
    HttpStatus.CONFLICT,
    'order-exists-part',
    `Номер ${order.orderNumber} уже є в системі — додати як ще одну частину?`,
    {
      orderNumber: order.orderNumber,
      clientName: order.clientName,
      amountDue: order.amountDue.toFixed(2),
      paid: amountPaid.toFixed(2),
    },
  );

/** The request as the orders will have it: the form's amounts and rates, the form's comment. */
function withOverrides(view: FinanceRequestView, input: Completion): FinanceRequestView {
  const overrides = toOrderOverrides(
    input.orders,
    view.orders.map((order) => order.orderNumber),
  );
  const typed = input.comment == null ? view.comment : input.comment.trim() || null;
  // a minus adds the answer to its own comment
  const percent =
    view.kind === 'minus' || view.withPercent === null
      ? null
      : `з урахуванням %: ${view.withPercent ? 'так' : 'ні'}`;
  const comment = [typed, percent].filter(Boolean).join(' · ') || null;
  return {
    ...view,
    comment,
    orders: view.orders.map((order) => ({ ...order, ...overrides.get(order.orderNumber) })),
  };
}

const NO_PAYMENT_DATE = 'no-payment-date';
const NO_PAYMENT_DATE_TEXT =
  'Дати оплати немає — натисніть «✅ Прийняти» у картці ще раз і вкажіть її у формі.';

/** When the client paid: the latest date among the payments, if any has one. */
const latest = (payments: Payment[]): Date | null =>
  payments.reduce<Date | null>(
    (best, { paidAt }) => (paidAt && (!best || paidAt > best) ? paidAt : best),
    null,
  );

/** When the client first paid: the date an order of payments in parts carries. */
const earliest = (payments: Payment[]): Date | null =>
  payments.reduce<Date | null>(
    (best, { paidAt }) => (paidAt && (!best || paidAt < best) ? paidAt : best),
    null,
  );

const sumOf = (amounts: (string | Prisma.Decimal)[]): Prisma.Decimal =>
  amounts.reduce<Prisma.Decimal>((sum, amount) => sum.plus(amount), new Prisma.Decimal(0));

const reported = (payment: Payment): ReportedPayment => ({
  payerName: payment.payerName ?? UNNAMED_PAYER,
  amount: new Prisma.Decimal(payment.amount),
  paidAt: payment.paidAt,
});

const requisiteOf = (payment: Payment) => ({
  payerName: payment.payerName ?? UNNAMED_PAYER,
  account: payment.account,
  amount: new Prisma.Decimal(payment.amount).toFixed(2),
  paidAt: payment.paidAt,
});

@Injectable()
export class RequestCompletionService {
  private readonly logger = new Logger(RequestCompletionService.name);

  constructor(
    private readonly finance: FinanceClient,
    private readonly cards: RequestCardsRepository,
    private readonly orders: OrdersService,
    private readonly requisites: RequisitesService,
    private readonly sender: TelegramSender,
    private readonly receipts: RequestReceiptsService,
    private readonly attachments: AttachmentsService,
  ) {}

  /** «✏️ Змінити»: the payments, and optionally the amounts, rates and comment, come from the form. */
  complete(
    manager: Manager,
    requestId: string,
    body: CompleteMiniappRequestDto,
  ): Promise<CompletionResult> {
    return this.finish(manager, requestId, {
      payments: (kind) => toPayments(kind, body.payments),
      orders: body.orders,
      comment: body.comment,
      addPart: body.addPart === true,
    });
  }

  /**
   * «✅ Прийняти»: the orders as the card showed them, with the payments stored at creation. A card
   * sent before its payments had dates still carries this button: it is redrawn with the form.
   */
  async accept(manager: Manager, requestId: string): Promise<CompletionResult> {
    try {
      return await this.finish(manager, requestId, {
        payments: (kind, card) => {
          const stored = storedPayments(card.payments);
          if (stored.length === 0 || stored.some((payment) => payment.paidAt === null)) {
            throw apiError(HttpStatus.BAD_REQUEST, NO_PAYMENT_DATE, NO_PAYMENT_DATE_TEXT);
          }
          return fromStored(stored);
        },
        addPart: false,
      });
    } catch (error) {
      if (
        error instanceof ApiError &&
        (error.getResponse() as ApiErrorBody).code === NO_PAYMENT_DATE
      ) {
        await this.safely(requestId, 'stale accept card', () => this.redrawManagerCard(requestId));
      }
      throw error;
    }
  }

  private async redrawManagerCard(requestId: string): Promise<void> {
    const card = await this.cards.byRequestId(requestId);
    if (card?.managerMessageId == null) return;
    const { request } = await this.finance.get(requestId);
    const { html, buttons } = managerCard(request, {
      miniAppUrl: this.sender.miniAppUrl,
      payments: storedPayments(card.payments),
    });
    await this.sender.editMessage(card.managerChatId, card.managerMessageId, html, buttons);
  }

  /**
   * «💰 Оплачено»: the client paid, the date goes to the orders and their payments. our_fop and
   * foreign_fop close with it; card and minus were closed at completion.
   */
  async markPaid(
    manager: Manager,
    requestId: string,
    body: PaidMiniappRequestDto,
  ): Promise<{ paidAt: string }> {
    const card = await this.cards.byRequestId(requestId);
    if (card?.managerId !== manager.id) throw notFound();
    if (!card.completedAt) {
      throw apiError(HttpStatus.CONFLICT, 'not-completed', 'Запит ще не оформлено');
    }
    const paidAt = toPaidAt(body);
    let view: FinanceRequestView;
    try {
      view = (await this.finance.get(requestId)).request;
    } catch (error) {
      throw financeError(error);
    }
    await this.orders.setPaidAt(card.orderIds, paidAt);
    await this.requisites.fillPaidAt(card.orderIds, paidAt);
    await this.safely(requestId, 'manager card', async () => {
      if (card.managerMessageId === null) return;
      const { html, buttons } = managerCard(view, {
        miniAppUrl: this.sender.miniAppUrl,
        completed: {
          orderNumbers: await this.orders.numbersByIds(card.orderIds),
          closed: true,
          paidAt,
        },
      });
      await this.sender.editMessage(card.managerChatId, card.managerMessageId, html, buttons);
    });
    return { paidAt: paidAt.toISOString() };
  }

  /**
   * «➕ Додати оплату» of our_fop and foreign_fop: the payments go to the request's first order, a report
   * to «Оплати», and the task closes once they reach the orders' sum.
   */
  async addPayments(
    manager: Manager,
    requestId: string,
    body: AddPaymentsMiniappDto,
  ): Promise<{ paid: string; due: string }> {
    const card = await this.cards.byRequestId(requestId);
    if (card?.managerId !== manager.id) throw notFound();
    const firstId = card.completedAt ? card.orderIds[0] : undefined;
    if (firstId === undefined) {
      throw apiError(HttpStatus.CONFLICT, 'not-completed', 'Запит ще не оформлено');
    }
    let view: FinanceRequestView;
    try {
      view = (await this.finance.get(requestId)).request;
    } catch (error) {
      throw financeError(error);
    }
    if (!paysAfterConfirm(view.kind)) {
      throw apiError(
        HttpStatus.CONFLICT,
        'not-pay-later',
        'Для цього запиту оплату вносять під час оформлення',
      );
    }
    const payments = toPayments(view.kind!, body.payments);
    if (payments.length === 0) {
      throw apiError(HttpStatus.BAD_REQUEST, 'invalid-request', 'Додайте хоча б один платіж.');
    }
    const before = await this.requisites.progress(card.orderIds);
    if (!before.paid.lessThan(before.due)) {
      throw apiError(HttpStatus.CONFLICT, 'fully-paid', 'Запит уже оплачено повністю');
    }

    await this.requisites.addMany(firstId, payments.map(requisiteOf), initiatorOf(manager));
    await this.orders.fillPaidAt(card.orderIds, earliest(payments)!);
    const { paid, due } = await this.requisites.progress(card.orderIds);
    const reached = !paid.lessThan(due);
    if (reached)
      await this.safely(requestId, 'closing', () => this.cards.claimClosing(requestId, new Date()));

    // the payments are stored: nothing below may fail the answer
    const orderNumbers = await this.orders.numbersByIds(card.orderIds).catch(() => []);
    await this.safely(requestId, 'payment report', async () => {
      const first = await this.orders.findById(firstId);
      const report = paymentReportMessage({
        orderNumbers,
        clientName: first?.clientName ?? '',
        managerName: manager.name,
        added: payments.map(reported),
        paid,
        due,
      });
      const replyTo = first?.adminMessageId ?? null;
      await this.sender.sendToTopic(
        'payments',
        report,
        undefined,
        replyTo === null ? {} : { replyTo },
      );
    });
    await this.safely(requestId, 'manager card', () =>
      this.markCompleted(card, view, orderNumbers, null, card.closedAt != null || reached, {
        paid,
        due,
      }),
    );
    return { paid: paid.toFixed(2), due: due.toFixed(2) };
  }

  /** What the payments of a request's orders add up to against what the orders are due. */
  progress(orderIds: number[]): Promise<{ paid: Prisma.Decimal; due: Prisma.Decimal }> {
    return this.requisites.progress(orderIds);
  }

  /** Files from the Mini App go to the request's first order, like a receipt replied to the card. */
  async addFiles(
    manager: Manager,
    requestId: string,
    files: Express.Multer.File[],
  ): Promise<{ attached: number }> {
    const card = await this.cards.byRequestId(requestId);
    if (card?.managerId !== manager.id) throw notFound();
    const firstId = card.orderIds[0];
    const order = firstId === undefined ? null : await this.orders.findById(firstId);
    if (!order) {
      throw apiError(
        HttpStatus.CONFLICT,
        'not-completed',
        'Файли можна додати після «✅ Прийняти»',
      );
    }
    if (files.length === 0) {
      throw apiError(HttpStatus.BAD_REQUEST, 'no-files', 'Додайте хоча б один файл');
    }
    const saved = await this.attachments.save(order, files, initiatorOf(manager), true);
    return { attached: saved.length };
  }

  private async finish(
    manager: Manager,
    requestId: string,
    input: Completion,
  ): Promise<CompletionResult> {
    const card = await this.cards.byRequestId(requestId);
    if (card?.managerId !== manager.id) throw notFound();

    if (card.completedAt) {
      throw apiError(HttpStatus.CONFLICT, 'already-completed', 'Запит уже оформлено');
    }
    // Every check that can refuse runs before the claim, so the claim only spans creating orders:
    // a refusal never leaves the card looking completed, and a receipt sent meanwhile is not lost.
    const requested = await this.acceptedView(requestId);
    const payments = input.payments(requested.kind!, card);
    // finance keeps its own numbers; only the orders take the overrides
    const view = withOverrides(requested, input);
    const live = view.kind === 'minus' ? null : await this.liveItems(view, input.addPart);
    // our_fop and foreign_fop stay open until their payments reach the orders' sum
    const sums =
      live && paysAfterConfirm(view.kind)
        ? {
            paid: sumOf(payments.map((payment) => payment.amount)),
            due: sumOf(live.items.map((item) => item.amount)),
          }
        : null;
    const close = !sums?.paid.lessThan(sums.due);

    // atomic: of two parallel completions only one may create orders
    if (!(await this.cards.claimCompletion(requestId, new Date(), close))) {
      throw apiError(HttpStatus.CONFLICT, 'already-completed', 'Запит уже оформлено');
    }

    const progress: Progress = {
      created: [],
      skipped: [],
      fallbackNotice: null,
      heldReceipts: (await this.cards.heldFiles(requestId)).length > 0,
    };
    let made: Made = { orders: [], skipped: [], notice: null };
    let note: string | undefined;
    try {
      made = await this.createOrders(manager, view, payments, live, progress);
    } catch (error) {
      if (progress.created.length === 0) {
        await this.release(requestId);
        throw error instanceof OrderNumberTakenError
          ? apiError(
              HttpStatus.CONFLICT,
              'order-taken',
              `Номер ${error.orderNumber} уже є в системі.`,
            )
          : error;
      }
      // the orders exist, so the claim stays: a retry would register the same payment twice
      this.logger.error(`Request ${requestId} created orders but did not finish`, error);
      made = {
        orders: progress.created,
        skipped: progress.skipped,
        notice: progress.fallbackNotice?.(progress.created) ?? null,
      };
      note = PARTIAL_NOTE;
    }

    // From here on the orders exist: nothing below may release the claim or fail the answer.
    const orderNumbers = made.orders.map((order) => order.orderNumber);
    // first, so that a receipt arriving from here on is attached at once instead of finding no order
    await this.safely(requestId, 'order ids', () =>
      this.cards.setOrderIds(
        requestId,
        made.orders.map((order) => order.id),
      ),
    );
    // with receipts held, the notice is their caption: one message in «Оплати» instead of two
    const merged =
      made.notice !== null &&
      made.notice !== undefined &&
      made.notice.length <= TELEGRAM_CAPTION_LIMIT &&
      made.orders[0] !== undefined &&
      (await this.cards.heldFiles(requestId)).length > 0;
    let noticeId = merged ? null : await this.announce(requestId, made);
    // a receipt held before this point is found here; one sent after the ids is attached at once
    const receiptsAttached = await this.safely(requestId, 'held receipts', async () => {
      if (made.orders[0]) {
        await this.receipts.attachHeld(
          manager,
          requestId,
          made.orders[0],
          merged ? (made.notice ?? undefined) : undefined,
        );
      }
    });
    // the files did not go: the notice must not get lost with them
    if (merged && !receiptsAttached) {
      noticeId = await this.announce(requestId, made);
    }
    if (!receiptsAttached) note = [note, RECEIPTS_NOTE].filter(Boolean).join(' ');
    const report = made.report;
    if (report) {
      await this.safely(requestId, 'payment report', () =>
        this.sender.sendToTopic(
          'payments',
          report,
          undefined,
          noticeId === null ? {} : { replyTo: noticeId },
        ),
      );
    }
    await this.safely(requestId, 'manager card', () =>
      this.markCompleted(card, requested, orderNumbers, latest(payments), close, sums),
    );
    return { orderNumbers, skipped: made.skipped, ...(note && { note }) };
  }

  /** The notice goes to «Оплати»; its message id stays on the orders so deleting one can remove it. */
  private async sendNotice(made: Made): Promise<number | null> {
    if (!made.notice) return null;
    const messageId = await this.sender.sendToAdmins(made.notice);
    if (messageId !== null && made.orders.length > 0) {
      await this.orders.setAdminMessageId(
        made.orders.map((order) => order.id),
        messageId,
      );
    }
    return messageId;
  }

  /** Like `safely`, but keeps the id of the notice for the payment report to reply to. */
  private async announce(requestId: string, made: Made): Promise<number | null> {
    try {
      return await this.sendNotice(made);
    } catch (error) {
      this.logger.error(`Request ${requestId}: admin notice failed`, error);
      return null;
    }
  }

  private async acceptedView(requestId: string): Promise<FinanceRequestView> {
    let view: FinanceRequestView;
    try {
      view = (await this.finance.get(requestId)).request;
    } catch (error) {
      throw financeError(error);
    }
    if (view.status !== 'accepted') {
      throw apiError(HttpStatus.CONFLICT, 'not-accepted', 'Запит ще не прийнято фінансистом');
    }
    if (view.kind !== null && ORDER_KINDS.includes(view.kind) && view.orders.length === 0) {
      throw apiError(
        HttpStatus.UNPROCESSABLE_ENTITY,
        'request-has-no-orders',
        'У запиті немає замовлень',
      );
    }
    if (view.kind === null) {
      throw apiError(HttpStatus.UNPROCESSABLE_ENTITY, 'finance-refused', 'Невідомий тип запиту');
    }
    return view;
  }

  private createOrders(
    manager: Manager,
    view: FinanceRequestView,
    payments: Payment[],
    live: LiveItems | null,
    progress: Progress,
  ): Promise<Made> {
    if (live === null) return this.createMinus(manager, view, payments, progress);
    return paysAfterConfirm(view.kind)
      ? this.createPayLater(manager, view, payments, live, progress)
      : this.createRequisites(manager, view, payments, live, progress);
  }

  private async createPayLater(
    manager: Manager,
    view: FinanceRequestView,
    payments: Payment[],
    { items, skipped, addPart: part }: LiveItems,
    progress: Progress,
  ): Promise<Made> {
    progress.skipped = skipped;
    // with payments the notice goes from here, so the payment report can reply to it
    const announced = progress.heldReceipts || payments.length > 0;
    const notices = (orders: Order[]) =>
      orders.map((order) => adminOrderCreatedMessage(order, manager)).join('\n\n');
    if (announced) progress.fallbackNotice = notices;
    const common = {
      clientName: view.fopLabel ?? (view.kind === 'foreign_fop' ? 'Чужий ФОП' : 'Наш ФОП'),
      currency: Currency.UAH,
      exchangeRate: view.exchangeRate ?? undefined,
      comment: view.comment ?? undefined,
      // the client may not have paid yet: no date until «➕ Додати оплату»
      paidAt: earliest(payments) ?? undefined,
    };
    const orders =
      items.length === 1
        ? [
            await this.orders.create(
              manager.id,
              {
                ...common,
                exchangeRate: items[0]!.rate ?? common.exchangeRate,
                orderType: OrderType.REGULAR,
                orderNumber: items[0]!.number,
                amountDue: items[0]!.amount.toFixed(2),
              },
              { notify: !announced, addPart: part },
            ),
          ]
        : await this.orders.createGroup(
            manager.id,
            items.map((item) => ({
              orderNumber: item.number,
              amountDue: item.amount.toFixed(2),
              exchangeRate: item.rate ?? undefined,
            })),
            common,
            { notify: !announced },
          );
    progress.created.push(...orders);
    if (payments.length === 0) {
      return { orders, skipped, notice: announced ? notices(orders) : null };
    }
    await this.requisites.addMany(orders[0]!.id, payments.map(requisiteOf), initiatorOf(manager));
    const report = paymentReportMessage({
      orderNumbers: orders.map((order) => order.orderNumber),
      clientName: orders[0]!.clientName,
      managerName: manager.name,
      added: payments.map(reported),
      paid: sumOf(payments.map((payment) => payment.amount)),
      due: sumOf(orders.map((order) => order.amountDue)),
    });
    return { orders, skipped, notice: notices(orders), report };
  }

  private async createRequisites(
    manager: Manager,
    view: FinanceRequestView,
    payments: Payment[],
    { items, skipped, addPart: part }: LiveItems,
    progress: Progress,
  ): Promise<Made> {
    progress.skipped = skipped;
    progress.fallbackNotice = (orders) => adminRequisitesMessage(orders, manager.name, [], skipped);
    const plan: RequisitesPlan = {
      kind: items.length > 1 ? 'group' : 'single',
      currency: Currency.UAH,
      items,
      total: items.reduce((sum, item) => sum.plus(item.amount), new Prisma.Decimal(0)),
      derivedTotal: false,
      rate: (items.length === 1 ? items[0]?.rate : null) ?? view.exchangeRate,
      label: payments[0]!.payerName ?? UNNAMED_PAYER,
      warnings: [],
      comment: view.comment,
      requisiteLines: payments.map((payment) => ({
        payerName: payment.payerName ?? UNNAMED_PAYER,
        account: payment.account,
        amount: new Prisma.Decimal(payment.amount).toFixed(2),
        paidAt: payment.paidAt,
      })),
    };
    const { orders, added } = await createRequisitesOrders(
      { orders: this.orders, requisites: this.requisites },
      manager,
      plan,
      part,
      (orders) => progress.created.push(...orders),
    );
    return {
      orders,
      skipped,
      notice: adminRequisitesMessage(orders, manager.name, added, skipped),
    };
  }

  private async createMinus(
    manager: Manager,
    view: FinanceRequestView,
    payments: Payment[],
    progress: Progress,
  ): Promise<Made> {
    const client = view.clientLabel ?? '';
    const described =
      payments.length > 1 ||
      payments.some((payment) => (payment.payerName ?? payment.account ?? null) !== null);
    const percent =
      view.withPercent === null ? null : `з урахуванням %: ${view.withPercent ? 'так' : 'ні'}`;
    progress.fallbackNotice = (orders) => adminMinusMessage(orders[0]!, manager.name, []);
    const { order, added } = await createMinusOrder(
      { orders: this.orders, requisites: this.requisites },
      manager,
      {
        clientName: client,
        period: null,
        paidAt: earliest(payments),
        currency: Currency.UAH,
        total: new Prisma.Decimal(view.sum),
        ourFop: view.fopLabel,
        requisiteLines: described ? payments.map(requisiteOf) : [],
        comment: [view.comment, percent].filter(Boolean).join(' · ') || null,
        rate: view.exchangeRate,
        sheetUrl: view.sheetUrl,
        warnings: [],
      },
      (orders) => progress.created.push(...orders),
    );
    return { orders: [order], skipped: [], notice: adminMinusMessage(order, manager.name, added) };
  }

  /** The request's orders minus the numbers that exist already, with the requisites flow's rules. */
  private async liveItems(view: FinanceRequestView, agreedToPart: boolean): Promise<LiveItems> {
    const items: PlanItem[] = view.orders.map((order) => ({
      number: order.orderNumber,
      amount: new Prisma.Decimal(order.amount),
      note: null,
      rate: order.exchangeRate,
    }));
    const check = await checkExistingNumbers(this.orders, {
      kind: items.length > 1 ? 'group' : 'single',
      currency: Currency.UAH,
      items,
    });
    if (!check.ok) throw numberTaken(check);
    // the bot always asks first; a request that already finished its asking carries `addPart`
    if (check.addPart && check.existing && !agreedToPart) throw partOffer(check.existing);
    return {
      items: items.filter((item) => !check.skipped.includes(item.number)),
      skipped: check.skipped,
      addPart: check.addPart,
    };
  }

  private async markCompleted(
    card: { managerChatId: bigint; managerMessageId: number | null },
    view: FinanceRequestView,
    orderNumbers: string[],
    paidAt: Date | null,
    closed: boolean,
    progress: { paid: Prisma.Decimal; due: Prisma.Decimal } | null,
  ): Promise<void> {
    if (card.managerMessageId === null) return;
    const { html, buttons } = managerCard(view, {
      miniAppUrl: this.sender.miniAppUrl,
      completed: { orderNumbers, closed, paidAt, ...(progress && { progress }) },
    });
    await this.sender.editMessage(card.managerChatId, card.managerMessageId, html, buttons);
  }

  /** Releasing is best effort: the original error matters more than a failed release. */
  private async release(requestId: string): Promise<void> {
    await this.safely(requestId, 'claim release', () => this.cards.releaseCompletion(requestId));
  }

  private async safely(
    requestId: string,
    what: string,
    step: () => Promise<unknown>,
  ): Promise<boolean> {
    try {
      await step();
      return true;
    } catch (error) {
      this.logger.error(`Request ${requestId}: ${what} failed`, error);
      return false;
    }
  }
}
