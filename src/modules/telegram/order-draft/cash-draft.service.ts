import { Injectable } from '@nestjs/common';
import type { Manager, Order } from '../../../generated/prisma/client';
import { OrderNumberTakenError } from '../../orders/orders.errors';
import type { BotReply } from '../core/bot-reply';
import { escapeHtml } from '../core/format';
import { TelegramSender } from '../core/telegram-sender';
import { adminCashMessage, cashCreatedReply, cashHint, cashPreview } from './cash.messages';
import { type CashPlan, cashPaymentId, parseCash } from './cash.parser';
import { DraftAttachmentNotifier } from './draft-attachment-notifier';
import { DraftModeStore } from './draft-mode.store';
import { PendingFilesStore } from './pending-files.store';
import { type ReportedItem, ReportedPaymentService } from './reported-payment.service';
import { requisitesErrors } from './requisites.messages';

export interface CashDraft {
  plan: CashPlan;
  /** The number is already in the system: it only gets the payment. */
  exists: boolean;
  expiresAt: number;
}

@Injectable()
export class CashDraftStore extends DraftModeStore<CashDraft> {}

// How long a manager has to answer the preview.
const CASH_DRAFT_TTL_MS = 10 * 60_000;

// How long the mode waits for the message after the button/command.
const CASH_MODE_TTL_MS = 30 * 60_000;

const CASH_LABEL = 'Оплата готівкою';

const cashItems = (plan: CashPlan): ReportedItem[] => [
  { number: plan.number, amount: plan.amount, paymentId: cashPaymentId(plan) },
];

// "💰 Оплата готівкою": arming the mode, reading one message in the cash template into a preview,
// then recording the cash on its number (ReportedPaymentService).
@Injectable()
export class CashDraftService {
  constructor(
    private readonly reported: ReportedPaymentService,
    private readonly pendingFiles: PendingFilesStore,
    private readonly drafts: CashDraftStore,
    private readonly sender: TelegramSender,
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

  // Drops the armed mode and any pending preview, reporting whether there was anything to drop.
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
    const check = await this.reported.check(cashItems(plan), plan.currency);
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

  async confirm(manager: Manager): Promise<BotReply> {
    const draft = this.drafts.takeDraft(manager.telegramId);
    if (!draft || draft.expiresAt < Date.now()) {
      return { html: '⚠️ Немає даних для відправки. Надішліть повідомлення ще раз.' };
    }
    const { plan, exists } = draft;
    const details = [
      CASH_LABEL,
      ...(plan.handedBy ? [plan.handedBy] : []),
      ...(plan.rate ? [`курс ${plan.rate.replace('.', ',')}`] : []),
    ].join(' · ');

    let fileOrder: Order | undefined;
    try {
      fileOrder = await this.reported.record(manager, {
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

    const files = this.pendingFiles.take(manager.telegramId);
    const notice = adminCashMessage(plan, exists, manager.name);
    if (files.length > 0 && fileOrder) {
      await this.notifier.notify(fileOrder, manager, files, notice);
    } else {
      await this.sender.sendToAdmins(notice);
    }
    return cashCreatedReply(plan);
  }

  pendingUserIds(now: number): bigint[] {
    return this.drafts.pendingUserIds(now);
  }
}
