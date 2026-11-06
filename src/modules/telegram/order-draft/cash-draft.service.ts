import { Injectable } from '@nestjs/common';
import type { Manager, Order } from '../../../generated/prisma/client';
import { OrderNumberTakenError } from '../../orders/orders.errors';
import type { BotReply } from '../core/bot-reply';
import { escapeHtml } from '../core/format';
import { cashCreatedReply, cashHint, cashPreview } from './cash.messages';
import { type CashPlan, cashPaymentId, parseCash } from './cash.parser';
import { DraftAttachmentNotifier } from './draft-attachment-notifier';
import { DraftModeStore } from './draft-mode.store';
import { PendingFilesStore } from './pending-files.store';
import {
  type ReportCheck,
  type ReportedItem,
  ReportedPaymentService,
} from './reported-payment.service';
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

const cashItems = (plan: CashPlan): ReportedItem[] => [
  { number: plan.number, amount: plan.amount, paymentId: cashPaymentId(plan) },
];

@Injectable()
export class CashDraftService {
  constructor(
    private readonly reported: ReportedPaymentService,
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
    if (!check.ok) {
      return check.alreadyRecorded
        ? { html: '⚠️ Цю оплату вже зареєстровано.' }
        : requisitesErrors(check.errors);
    }
    const exists = check.existing.length > 0;
    this.drafts.setDraft(manager.telegramId, {
      plan,
      exists,
      expiresAt: Date.now() + CASH_DRAFT_TTL_MS,
    });
    return cashPreview(plan, exists, this.pendingFiles.list(manager.telegramId).length);
  }

  check(plan: CashPlan): Promise<ReportCheck> {
    return this.reported.check(cashItems(plan), plan.currency);
  }

  /**
   * Creates the order unless it exists and records the payment; returns the order the files belong to.
   * Throws OrderNumberTakenError if the number just appeared.
   */
  record(manager: Manager, plan: CashPlan, exists: boolean): Promise<Order | undefined> {
    const details = [
      CASH_LABEL,
      ...(plan.handedBy ? [plan.handedBy] : []),
      ...(plan.rate ? [`курс ${plan.rate.replace('.', ',')}`] : []),
      ...(plan.withPercent === null ? [] : [`з урахуванням %: ${plan.withPercent ? 'так' : 'ні'}`]),
      ...(plan.comment ? [plan.comment] : []),
    ].join(' · ');

    return this.reported.record(manager, {
      label: CASH_LABEL,
      currency: plan.currency,
      items: cashItems(plan),
      existing: exists ? [plan.number] : [],
      paidAt: plan.paidAt,
      payerName: plan.handedBy ?? CASH_LABEL,
      receivingAccount: 'Готівка',
      purpose: details,
      comment: details,
      exchangeRate: plan.rate ?? undefined,
    });
  }

  async confirm(manager: Manager): Promise<BotReply> {
    const draft = this.drafts.takeDraft(manager.telegramId);
    if (!draft || draft.expiresAt < Date.now()) {
      return { html: '⚠️ Немає даних для відправки. Надішліть повідомлення ще раз.' };
    }
    const { plan, exists } = draft;

    let fileOrder: Order | undefined;
    try {
      fileOrder = await this.record(manager, plan, exists);
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

    // cash never goes to the financiers: receipts only land in the storage chat
    const files = this.pendingFiles.take(manager.telegramId);
    if (files.length > 0 && fileOrder) await this.notifier.store(fileOrder, manager, files);
    return cashCreatedReply(plan);
  }

  pendingUserIds(now: number): bigint[] {
    return this.drafts.pendingUserIds(now);
  }
}
