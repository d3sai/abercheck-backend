import { HttpStatus, Injectable } from '@nestjs/common';
import type { Manager } from '../../generated/prisma/client';
import { ApiError } from '../../common/api-error';
import { OrderNumberTakenError } from '../orders/orders.errors';
import { OrdersService } from '../orders/orders.service';
import type { TelegramFileRef } from '../attachments/attachments.service';
import type { BotReply } from '../telegram/core/bot-reply';
import { TelegramSender } from '../telegram/core/telegram-sender';
import { CashDraftService } from '../telegram/order-draft/cash-draft.service';
import type { CashPlan } from '../telegram/order-draft/cash.parser';
import { ForeignDraftService } from '../telegram/order-draft/foreign-draft.service';
import type { ForeignPlan } from '../telegram/order-draft/foreign.parser';
import { KitDraftService } from '../telegram/order-draft/kit-draft.service';
import type { KitPlan } from '../telegram/order-draft/kit.parser';
import { cashPreview } from '../telegram/order-draft/cash.messages';
import { foreignCreatedReply, foreignPreview } from '../telegram/order-draft/foreign.messages';
import { kitPreview } from '../telegram/order-draft/kit.messages';
import { type OrderPlan, type PaidMiniappRequestDto, toPaidAt } from './miniapp.dto';
import { notFound } from './miniapp.errors';

export interface DirectOrdersResult {
  /** Numbers created as new orders. */
  orderNumbers: string[];
  /** Numbers the system already had: the payment was only recorded or the notice sent. */
  skipped: string[];
  note?: string;
}

/** What «💰 Оплачено» shows of an order made without a request. */
export interface DirectOrderView {
  orderNumber: string;
  clientName: string;
  amount: string;
  currency: string;
  paidAt: string | null;
}

const conflict = (code: string, message: string): ApiError =>
  new ApiError(HttpStatus.CONFLICT, code, message);

/** Kit, cash and foreign payments from the form: the text modes' check and create steps, without the draft. */
@Injectable()
export class DirectOrdersService {
  constructor(
    private readonly kit: KitDraftService,
    private readonly cash: CashDraftService,
    private readonly foreign: ForeignDraftService,
    private readonly orders: OrdersService,
    private readonly sender: TelegramSender,
  ) {}

  /** The manager's own order; another manager's looks exactly like a missing one. */
  private async ownOrder(manager: Manager, orderNumber: string) {
    const found = await this.orders.findWithBalance(orderNumber);
    if (found?.order.managerId !== manager.id) throw notFound();
    return found.order;
  }

  async view(manager: Manager, orderNumber: string): Promise<DirectOrderView> {
    const order = await this.ownOrder(manager, orderNumber);
    return {
      orderNumber: order.orderNumber,
      clientName: order.clientName,
      amount: order.amountDue.toFixed(2),
      currency: order.currency,
      paidAt: order.paidAt?.toISOString() ?? null,
    };
  }

  /** «💰 Оплачено» of an order made without a request: the date and time the client paid. */
  async markPaid(
    manager: Manager,
    orderNumber: string,
    body: PaidMiniappRequestDto,
  ): Promise<{ paidAt: string }> {
    const order = await this.ownOrder(manager, orderNumber);
    const paidAt = toPaidAt(body);
    await this.orders.setPaidAt([order.id], paidAt);
    return { paidAt: paidAt.toISOString() };
  }

  /** The text of the card a form order waits in; refuses what `create` would refuse. */
  async preview(order: OrderPlan): Promise<BotReply> {
    switch (order.kind) {
      case 'kit':
        return kitPreview(order.plan, await this.kit.existingNumbers(order.plan), 0);
      case 'cash': {
        const check = await this.cashCheck(order.plan);
        return cashPreview(order.plan, check.exists, 0);
      }
      case 'foreign':
        return foreignPreview(order.plan, await this.foreign.exists(order.plan), 0);
    }
  }

  /** `files` are the receipts held on the card: they go with the notice as one message in «Оплати». */
  async create(
    manager: Manager,
    order: OrderPlan,
    files: TelegramFileRef[] = [],
  ): Promise<DirectOrdersResult> {
    try {
      switch (order.kind) {
        case 'kit':
          return await this.createKit(manager, order.plan, files);
        case 'cash':
          return await this.createCash(manager, order.plan, files);
        case 'foreign':
          return await this.createForeign(manager, order.plan, files);
      }
    } catch (error) {
      if (error instanceof OrderNumberTakenError) {
        throw conflict(
          'order-taken',
          `Номер ${error.orderNumber} щойно з'явився в системі. Перевірте форму й надішліть ще раз.`,
        );
      }
      throw error;
    }
  }

  private async createKit(
    manager: Manager,
    plan: KitPlan,
    files: TelegramFileRef[],
  ): Promise<DirectOrdersResult> {
    const existing = await this.kit.existingNumbers(plan);
    const created = await this.kit.createOrders(manager, plan, existing);
    await this.kit.announce(manager, plan, existing, created, files);
    return {
      orderNumbers: plan.items
        .map((item) => item.number)
        .filter((number) => !existing.includes(number)),
      skipped: existing,
      ...(existing.length > 0 && {
        note: 'Частина номерів уже є в системі, їх не створено вдруге.',
      }),
    };
  }

  private async createCash(
    manager: Manager,
    plan: CashPlan,
    files: TelegramFileRef[],
  ): Promise<DirectOrdersResult> {
    const { exists } = await this.cashCheck(plan);
    const created = await this.cash.createOrder(manager, plan, exists);
    await this.cash.announce(manager, plan, exists, created, files);
    return exists
      ? {
          orderNumbers: [],
          skipped: [plan.number],
          note: 'Замовлення вже є в системі, адмінам надіслано шаблон.',
        }
      : { orderNumbers: [plan.number], skipped: [] };
  }

  private async cashCheck(plan: CashPlan) {
    const check = await this.cash.check(plan);
    if (!check.ok) throw conflict('order-conflict', check.errors.join(' '));
    return check;
  }

  private async createForeign(
    manager: Manager,
    plan: ForeignPlan,
    files: TelegramFileRef[],
  ): Promise<DirectOrdersResult> {
    const exists = await this.foreign.exists(plan);
    const created = await this.foreign.createOrder(manager, plan, exists);
    await this.foreign.announce(manager, plan, exists, created, files);
    // a form has no bot reply to carry the button, so the bot writes to the manager
    if (created && !plan.paidAt) {
      const { html, buttons } = foreignCreatedReply(plan, this.sender.miniAppUrl);
      if (buttons) await this.sender.send(manager.telegramId, html, buttons);
    }
    return exists
      ? {
          orderNumbers: [],
          skipped: [plan.number],
          note: 'Замовлення вже є в системі, адмінам надіслано шаблон.',
        }
      : { orderNumbers: [plan.number], skipped: [] };
  }
}
