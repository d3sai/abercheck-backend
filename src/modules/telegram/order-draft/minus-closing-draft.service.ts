import { Injectable } from '@nestjs/common';
import { type Manager, OrderType } from '../../../generated/prisma/client';
import { OrdersService } from '../../orders/orders.service';
import { RequisitesService } from '../../requisites/requisites.service';
import type { BotReply } from '../core/bot-reply';
import { TelegramSender } from '../core/telegram-sender';
import { DraftAttachmentNotifier } from './draft-attachment-notifier';
import { DraftModeStore } from './draft-mode.store';
import {
  adminMinusMessage,
  minusCreatedReply,
  minusHint,
  minusPreview,
} from './minus-closing.messages';
import { type MinusPlan, parseMinusClosing } from './minus-closing.parser';
import { PendingFilesStore } from './pending-files.store';
import { requisitesErrors } from './requisites.messages';

export interface MinusDraft {
  plan: MinusPlan;
  expiresAt: number;
}

@Injectable()
export class MinusDraftStore extends DraftModeStore<MinusDraft> {}

// How long a manager has to answer the preview.
const MINUS_DRAFT_TTL_MS = 10 * 60_000;

// How long the mode waits for the message after the button/command.
const MINUS_MODE_TTL_MS = 30 * 60_000;

// "➖ Закрити мінус": arming the mode, reading one message in the "Закриття заборгованості клієнта"
// template (or written freely) into a preview, and creating the closing once it is confirmed.
@Injectable()
export class MinusClosingDraftService {
  constructor(
    private readonly orders: OrdersService,
    private readonly requisites: RequisitesService,
    private readonly pendingFiles: PendingFilesStore,
    private readonly drafts: MinusDraftStore,
    private readonly sender: TelegramSender,
    private readonly notifier: DraftAttachmentNotifier,
  ) {}

  start(userId: bigint): BotReply {
    this.drafts.clearDraft(userId);
    this.drafts.arm(userId, Date.now() + MINUS_MODE_TTL_MS);
    return minusHint();
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
    this.drafts.arm(userId, Date.now() + MINUS_MODE_TTL_MS);
    return { html: 'Гаразд. Надішліть виправлене повідомлення.' };
  }

  handle(manager: Manager, text: string): BotReply {
    const parsed = parseMinusClosing(text.trim());
    if (!parsed.ok) {
      return requisitesErrors(parsed.errors);
    }
    this.drafts.setDraft(manager.telegramId, {
      plan: parsed.plan,
      expiresAt: Date.now() + MINUS_DRAFT_TTL_MS,
    });
    return minusPreview(parsed.plan, this.pendingFiles.list(manager.telegramId).length);
  }

  async confirm(manager: Manager): Promise<BotReply> {
    const draft = this.drafts.takeDraft(manager.telegramId);
    if (!draft || draft.expiresAt < Date.now()) {
      return { html: '⚠️ Немає даних для відправки. Надішліть повідомлення ще раз.' };
    }
    const { plan } = draft;
    const order = await this.orders.create(
      manager.id,
      {
        orderType: OrderType.MINUS_CLOSING,
        clientName: plan.clientName,
        amountDue: plan.total.toFixed(2),
        currency: plan.currency,
        exchangeRate: plan.rate ?? undefined,
        comment: plan.comment ?? undefined,
        paidAt: plan.paidAt ?? undefined,
        ourFop: plan.ourFop ?? undefined,
        period: plan.period ?? undefined,
        sheetUrl: plan.sheetUrl ?? undefined,
      },
      { notify: false },
    );
    this.drafts.disarm(manager.telegramId);

    const added =
      plan.requisiteLines.length > 0
        ? await this.requisites.addMany(order.id, plan.requisiteLines, {
            telegramId: manager.telegramId,
            name: manager.name,
          })
        : [];
    const files = this.pendingFiles.take(manager.telegramId);
    const notice = adminMinusMessage(order, manager.name, added);
    if (files.length > 0) {
      await this.notifier.notify(order, manager, files, notice);
    } else {
      await this.sender.sendToAdmins(notice);
    }
    return minusCreatedReply(order);
  }

  pendingUserIds(now: number): bigint[] {
    return this.drafts.pendingUserIds(now);
  }
}
