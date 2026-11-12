import { Injectable } from '@nestjs/common';
import type { TelegramFileRef } from '../../attachments/attachments.service';
import {
  type Currency,
  type Manager,
  type Order,
  OrderStatus,
} from '../../../generated/prisma/client';
import { OrderNumberTakenError } from '../../orders/orders.errors';
import { OrdersService } from '../../orders/orders.service';
import type { BotReply } from '../core/bot-reply';
import { escapeHtml } from '../core/format';
import { TelegramSender } from '../core/telegram-sender';
import { adminCashMessage, cashCreatedReply, cashHint, cashPreview } from './cash.messages';
import { type CashPlan, parseCash } from './cash.parser';
import { DraftAttachmentNotifier } from './draft-attachment-notifier';
import { DraftModeStore } from './draft-mode.store';
import { PendingFilesStore } from './pending-files.store';
import { requisitesErrors } from './requisites.messages';

export interface CashDraft {
  plan: CashPlan;
  exists: boolean;
  expiresAt: number;
}

@Injectable()
export class CashDraftStore extends DraftModeStore<CashDraft> {}

const CASH_DRAFT_TTL_MS = 10 * 60_000;

const CASH_MODE_TTL_MS = 30 * 60_000;

const CASH_LABEL = 'Оплата готівкою';

const IN_CURRENCY: Record<Currency, string> = { UAH: 'гривнях', USD: 'доларах', EUR: 'євро' };

export type CashCheck = { ok: true; exists: boolean } | { ok: false; errors: string[] };

@Injectable()
export class CashDraftService {
  constructor(
    private readonly orders: OrdersService,
    private readonly sender: TelegramSender,
    private readonly pendingFiles: PendingFilesStore,
    private readonly drafts: CashDraftStore,
    private readonly notifier: DraftAttachmentNotifier,
  ) {}

  start(userId: bigint): BotReply {
    this.drafts.clearDraft(userId);
    this.drafts.arm(userId, Date.now() + CASH_MODE_TTL_MS);
    return cashHint();
  }

  isArmed(userId: bigint): boolean {
    return this.drafts.isArmed(userId);
  }

  leave(userId: bigint): boolean {
    return this.drafts.leave(userId);
  }

  edit(userId: bigint): BotReply {
    this.drafts.clearDraft(userId);
    this.drafts.arm(userId, Date.now() + CASH_MODE_TTL_MS);
    return { html: 'Гаразд. Надішліть виправлене повідомлення.' };
  }

  async handle(manager: Manager, text: string): Promise<BotReply> {
    const parsed = parseCash(text.trim());
    if (!parsed.ok) {
      return requisitesErrors(parsed.errors);
    }
    const { plan } = parsed;
    const check = await this.check(plan);
    if (!check.ok) return requisitesErrors(check.errors);
    const { exists } = check;
    this.drafts.setDraft(manager.telegramId, {
      plan,
      exists,
      expiresAt: Date.now() + CASH_DRAFT_TTL_MS,
    });
    return cashPreview(plan, exists, this.pendingFiles.list(manager.telegramId).length);
  }

  /** A cancelled number or one in another currency cannot take the payment. */
  async check(plan: CashPlan): Promise<CashCheck> {
    const order = (await this.orders.findWithBalance(plan.number))?.order;
    if (!order) return { ok: true, exists: false };
    if (order.status === OrderStatus.CANCELLED) {
      return { ok: false, errors: [`№ ${plan.number} скасовано, оплату до нього не додати.`] };
    }
    if (order.currency !== plan.currency) {
      return {
        ok: false,
        errors: [
          `№ ${plan.number} у ${IN_CURRENCY[order.currency]}, а оплата в ${IN_CURRENCY[plan.currency]}.`,
        ],
      };
    }
    return { ok: true, exists: true };
  }

  /** Creates the order unless it exists; throws OrderNumberTakenError if it just appeared. */
  async createOrder(manager: Manager, plan: CashPlan, exists: boolean): Promise<Order | undefined> {
    if (exists) return undefined;
    const [created] = await this.orders.createGroup(
      manager.id,
      [{ orderNumber: plan.number, amountDue: plan.amount.toFixed(2) }],
      {
        clientName: CASH_LABEL,
        currency: plan.currency,
        exchangeRate: plan.rate ?? undefined,
        paidAt: plan.paidAt ?? undefined,
        comment: [
          CASH_LABEL,
          plan.handedBy,
          plan.rate && `курс ${plan.rate.replace('.', ',')}`,
          plan.withPercent === null ? null : `з урахуванням %: ${plan.withPercent ? 'так' : 'ні'}`,
          plan.comment,
        ]
          .filter(Boolean)
          .join(' · '),
      },
    );
    return created;
  }

  /** Tells the admins; the files, if any, go with the notice on the order. The payment comes from the payments service. */
  async announce(
    manager: Manager,
    plan: CashPlan,
    exists: boolean,
    created: Order | undefined,
    files: TelegramFileRef[] = [],
  ): Promise<void> {
    const notice = adminCashMessage(plan, exists, manager.name);
    const fileOrder =
      files.length > 0
        ? (created ?? (await this.orders.findWithBalance(plan.number))?.order)
        : undefined;
    if (fileOrder) {
      await this.notifier.notify(fileOrder, manager, files, notice);
    } else {
      await this.notifier.notice(created ? [created] : [], notice);
    }
  }

  async confirm(manager: Manager): Promise<BotReply> {
    const draft = this.drafts.takeDraft(manager.telegramId);
    if (!draft || draft.expiresAt < Date.now()) {
      return { html: '⚠️ Немає даних для відправки. Надішліть повідомлення ще раз.' };
    }
    const { plan, exists } = draft;

    let created: Order | undefined;
    try {
      created = await this.createOrder(manager, plan, exists);
    } catch (error) {
      if (error instanceof OrderNumberTakenError) {
        this.drafts.arm(manager.telegramId, Date.now() + CASH_MODE_TTL_MS);
        return {
          html: `⚠️ Номер ${escapeHtml(error.orderNumber)} щойно з'явився в системі. Надішліть повідомлення ще раз.`,
        };
      }
      throw error;
    }
    this.drafts.disarm(manager.telegramId);

    await this.announce(manager, plan, exists, created, this.pendingFiles.take(manager.telegramId));
    return cashCreatedReply(plan, created?.orderNumber);
  }

  pendingUserIds(now: number): bigint[] {
    return this.drafts.pendingUserIds(now);
  }
}
