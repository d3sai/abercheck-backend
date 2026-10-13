import { Injectable } from '@nestjs/common';
import { Currency, type Manager, type Order } from '../../../generated/prisma/client';
import { OrderNumberTakenError } from '../../orders/orders.errors';
import { OrdersService } from '../../orders/orders.service';
import type { BotReply } from '../core/bot-reply';
import { escapeHtml } from '../core/format';
import { TelegramSender } from '../core/telegram-sender';
import { DraftAttachmentNotifier } from './draft-attachment-notifier';
import { DraftModeStore } from './draft-mode.store';
import {
  adminForeignMessage,
  foreignCreatedReply,
  foreignHint,
  foreignPreview,
} from './foreign.messages';
import { type ForeignPlan, parseForeign } from './foreign.parser';
import { PendingFilesStore } from './pending-files.store';
import { requisitesErrors } from './requisites.messages';

export interface ForeignDraft {
  plan: ForeignPlan;
  exists: boolean;
  expiresAt: number;
}

@Injectable()
export class ForeignDraftStore extends DraftModeStore<ForeignDraft> {}

const FOREIGN_DRAFT_TTL_MS = 10 * 60_000;

const FOREIGN_MODE_TTL_MS = 30 * 60_000;

const FOREIGN_LABEL = 'Оплата закордонного замовлення';

@Injectable()
export class ForeignDraftService {
  constructor(
    private readonly orders: OrdersService,
    private readonly pendingFiles: PendingFilesStore,
    private readonly drafts: ForeignDraftStore,
    private readonly sender: TelegramSender,
    private readonly notifier: DraftAttachmentNotifier,
  ) {}

  start(userId: bigint): BotReply {
    this.drafts.clearDraft(userId);
    this.drafts.arm(userId, Date.now() + FOREIGN_MODE_TTL_MS);
    return foreignHint();
  }

  isArmed(userId: bigint): boolean {
    return this.drafts.isArmed(userId);
  }

  leave(userId: bigint): boolean {
    return this.drafts.leave(userId);
  }

  edit(userId: bigint): BotReply {
    this.drafts.clearDraft(userId);
    this.drafts.arm(userId, Date.now() + FOREIGN_MODE_TTL_MS);
    return { html: 'Гаразд. Надішліть виправлене повідомлення.' };
  }

  async handle(manager: Manager, text: string): Promise<BotReply> {
    const parsed = parseForeign(text.trim());
    if (!parsed.ok) {
      return requisitesErrors(parsed.errors);
    }
    const { plan } = parsed;
    const exists = Boolean(await this.orders.findWithBalance(plan.number));
    this.drafts.setDraft(manager.telegramId, {
      plan,
      exists,
      expiresAt: Date.now() + FOREIGN_DRAFT_TTL_MS,
    });
    return foreignPreview(plan, exists, this.pendingFiles.list(manager.telegramId).length);
  }

  async confirm(manager: Manager): Promise<BotReply> {
    const draft = this.drafts.takeDraft(manager.telegramId);
    if (!draft || draft.expiresAt < Date.now()) {
      return { html: '⚠️ Немає даних для відправки. Надішліть повідомлення ще раз.' };
    }
    const { plan, exists } = draft;

    let created: Order | undefined;
    try {
      if (!exists) {
        [created] = await this.orders.createGroup(
          manager.id,
          [{ orderNumber: plan.number, amountDue: plan.amount.toFixed(2) }],
          {
            clientName: FOREIGN_LABEL,
            currency: Currency.EUR,
            exchangeRate: plan.rate ?? undefined,
            paidAt: plan.paidAt ?? undefined,
            comment: [FOREIGN_LABEL, plan.recipient && `на ${plan.recipient}`, plan.comment]
              .filter(Boolean)
              .join(' · '),
          },
        );
      }
    } catch (error) {
      if (error instanceof OrderNumberTakenError) {
        this.drafts.arm(manager.telegramId, Date.now() + FOREIGN_MODE_TTL_MS);
        return {
          html: `⚠️ Номер ${escapeHtml(error.orderNumber)} щойно з'явився в системі. Надішліть повідомлення ще раз.`,
        };
      }
      throw error;
    }
    this.drafts.disarm(manager.telegramId);

    const files = this.pendingFiles.take(manager.telegramId);
    const notice = adminForeignMessage(plan, exists, manager.name);
    const fileOrder =
      files.length > 0
        ? (created ?? (await this.orders.findWithBalance(plan.number))?.order)
        : undefined;
    if (fileOrder) {
      await this.notifier.notify(fileOrder, manager, files, notice);
    } else {
      await this.sender.sendToAdmins(notice);
    }
    return foreignCreatedReply(plan);
  }

  pendingUserIds(now: number): bigint[] {
    return this.drafts.pendingUserIds(now);
  }
}
