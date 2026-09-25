import { Injectable } from '@nestjs/common';
import { Currency, type Manager, type Order } from '../../../generated/prisma/client';
import { OrderNumberTakenError } from '../../orders/orders.errors';
import { OrdersService } from '../../orders/orders.service';
import type { BotReply } from '../core/bot-reply';
import { escapeHtml } from '../core/format';
import { TelegramSender } from '../core/telegram-sender';
import { DraftAttachmentNotifier } from './draft-attachment-notifier';
import { DraftModeStore } from './draft-mode.store';
import { adminKitMessage, kitCreatedReply, kitHint, kitPreview } from './kit.messages';
import { type KitPlan, parseKit } from './kit.parser';
import { PendingFilesStore } from './pending-files.store';
import { requisitesErrors } from './requisites.messages';

export interface KitDraft {
  plan: KitPlan;
  /** Numbers already in the system: nothing is created for them. */
  existing: string[];
  expiresAt: number;
}

@Injectable()
export class KitDraftStore extends DraftModeStore<KitDraft> {}

// How long a manager has to answer the preview.
const KIT_DRAFT_TTL_MS = 10 * 60_000;

// How long the mode waits for the message after the button/command.
const KIT_MODE_TTL_MS = 30 * 60_000;

const KIT_LABEL = 'Оплата на Кит';

// "💵 Оплата на Кит": arming the mode, reading one message in the Кит template into a preview, then
// creating the numbers not yet in the system and telling the admins. It records no payment: the
// admins attach it themselves.
@Injectable()
export class KitDraftService {
  constructor(
    private readonly orders: OrdersService,
    private readonly pendingFiles: PendingFilesStore,
    private readonly drafts: KitDraftStore,
    private readonly sender: TelegramSender,
    private readonly notifier: DraftAttachmentNotifier,
  ) {}

  start(userId: bigint): BotReply {
    this.drafts.clearDraft(userId);
    this.drafts.arm(userId, Date.now() + KIT_MODE_TTL_MS);
    return kitHint();
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
    this.drafts.arm(userId, Date.now() + KIT_MODE_TTL_MS);
    return { html: 'Гаразд. Надішліть виправлене повідомлення.' };
  }

  async handle(manager: Manager, text: string): Promise<BotReply> {
    const parsed = parseKit(text.trim());
    if (!parsed.ok) {
      return requisitesErrors(parsed.errors);
    }
    const { plan } = parsed;
    const found = await Promise.all(
      plan.items.map((item) => this.orders.findWithBalance(item.number)),
    );
    const existing = plan.items.filter((_, index) => found[index]).map((item) => item.number);
    this.drafts.setDraft(manager.telegramId, {
      plan,
      existing,
      expiresAt: Date.now() + KIT_DRAFT_TTL_MS,
    });
    return kitPreview(plan, existing, this.pendingFiles.list(manager.telegramId).length);
  }

  async confirm(manager: Manager): Promise<BotReply> {
    const draft = this.drafts.takeDraft(manager.telegramId);
    if (!draft || draft.expiresAt < Date.now()) {
      return { html: '⚠️ Немає даних для відправки. Надішліть повідомлення ще раз.' };
    }
    const { plan, existing } = draft;
    const fresh = plan.items.filter((item) => !existing.includes(item.number));

    let created: Order[] = [];
    try {
      if (fresh.length > 0) {
        created = await this.orders.createGroup(
          manager.id,
          fresh.map((item) => ({
            orderNumber: item.number,
            amountDue: item.amount.toFixed(2),
          })),
          {
            clientName: KIT_LABEL,
            currency: Currency.USD,
            paidAt: plan.paidAt ?? undefined,
            comment: [`${KIT_LABEL} · код доступу ${plan.accessCode}`, plan.comment]
              .filter(Boolean)
              .join(' · '),
          },
        );
      }
    } catch (error) {
      if (error instanceof OrderNumberTakenError) {
        this.drafts.arm(manager.telegramId, Date.now() + KIT_MODE_TTL_MS);
        return {
          html: `⚠️ Номер ${escapeHtml(error.orderNumber)} щойно з'явився в системі. Надішліть повідомлення ще раз.`,
        };
      }
      throw error;
    }
    this.drafts.disarm(manager.telegramId);

    const files = this.pendingFiles.take(manager.telegramId);
    const notice = adminKitMessage(plan, existing, manager.name);
    // With every number already in the system, the files go to the first of them.
    const fileOrder =
      files.length > 0
        ? (created[0] ?? (await this.orders.findWithBalance(existing[0]!))?.order)
        : undefined;
    if (fileOrder) {
      await this.notifier.notify(fileOrder, manager, files, notice);
    } else {
      await this.sender.sendToAdmins(notice);
    }
    return kitCreatedReply(plan, created.length);
  }

  pendingUserIds(now: number): bigint[] {
    return this.drafts.pendingUserIds(now);
  }
}
