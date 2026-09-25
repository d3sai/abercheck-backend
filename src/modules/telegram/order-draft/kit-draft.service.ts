import { Injectable } from '@nestjs/common';
import { Currency, type Manager, type Order, OrderStatus } from '../../../generated/prisma/client';
import { OrderNumberTakenError } from '../../orders/orders.errors';
import { OrdersService } from '../../orders/orders.service';
import { PaymentsService } from '../../payments/payments.service';
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
  /** Numbers already in the system: they only get the payment, nothing is created for them. */
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

// One payment per number and transfer, so sending the same message twice never pays twice.
const kitPaymentId = (accessCode: string, number: string): string => `kit:${accessCode}:${number}`;

// "💵 Оплата на Кит": arming the mode, reading one message in the Кит template into a preview, then
// creating the numbers not yet in the system and recording the transfer's share on every number —
// the money has already arrived, and no bank statement will ever report it.
@Injectable()
export class KitDraftService {
  constructor(
    private readonly orders: OrdersService,
    private readonly payments: PaymentsService,
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

    const recorded = await Promise.all(
      plan.items.map((item) =>
        this.payments.findByExternalId(kitPaymentId(plan.accessCode, item.number)),
      ),
    );
    if (recorded.every(Boolean)) {
      return { html: '⚠️ Цей переказ уже зареєстровано.' };
    }

    const found = await Promise.all(
      plan.items.map((item) => this.orders.findWithBalance(item.number)),
    );
    const errors: string[] = [];
    const existing: string[] = [];
    plan.items.forEach((item, index) => {
      const order = found[index]?.order;
      if (!order) {
        return;
      }
      if (order.status === OrderStatus.CANCELLED) {
        errors.push(`№ ${item.number} скасовано, оплату до нього не додати.`);
      } else if (order.currency !== Currency.USD) {
        errors.push(`№ ${item.number} у гривнях, а переказ на Кит у доларах.`);
      } else {
        existing.push(item.number);
      }
    });
    if (errors.length > 0) {
      return requisitesErrors(errors);
    }

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

    let created: Order[];
    try {
      created = await this.createNew(manager, plan, existing);
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

    // Each recorded payment notifies the order's manager the same way a bank payment does.
    let paidOrder: Order | undefined;
    for (const item of plan.items) {
      const result = await this.payments.ingest({
        external_transaction_id: kitPaymentId(plan.accessCode, item.number),
        order_number: item.number,
        amount: item.amount.toFixed(2),
        currency: Currency.USD,
        payer_name: KIT_LABEL,
        receiving_account: 'Кит',
        purpose_text: `Код доступу ${plan.accessCode}`,
        paid_at: (plan.paidAt ?? new Date()).toISOString(),
      });
      if (result.kind === 'recorded') {
        paidOrder ??= result.order;
      }
    }

    const files = this.pendingFiles.take(manager.telegramId);
    const notice = adminKitMessage(plan, existing, manager.name);
    const fileOrder = created[0] ?? paidOrder;
    if (files.length > 0 && fileOrder) {
      await this.notifier.notify(fileOrder, manager, files, notice);
    } else {
      await this.sender.sendToAdmins(notice);
    }
    return kitCreatedReply(plan);
  }

  pendingUserIds(now: number): bigint[] {
    return this.drafts.pendingUserIds(now);
  }

  private async createNew(manager: Manager, plan: KitPlan, existing: string[]): Promise<Order[]> {
    const fresh = plan.items.filter((item) => !existing.includes(item.number));
    if (fresh.length === 0) {
      return [];
    }
    return this.orders.createGroup(
      manager.id,
      fresh.map((item) => ({ orderNumber: item.number, amountDue: item.amount.toFixed(2) })),
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
}
