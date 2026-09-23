import { Injectable } from '@nestjs/common';
import { type Manager, type Order, OrderType } from '../../../generated/prisma/client';
import { normalizeBaseNumber } from '../../orders/order-number';
import { OrderNumberTakenError } from '../../orders/orders.errors';
import { OrdersService } from '../../orders/orders.service';
import { RequisitesService } from '../../requisites/requisites.service';
import type { BotReply } from '../core/bot-reply';
import { escapeHtml } from '../core/format';
import { TelegramSender } from '../core/telegram-sender';
import { DraftAttachmentNotifier } from './draft-attachment-notifier';
import { OrderCreationFlow } from './order-creation.flow';
import { PartOfferStore } from './part-offer.store';
import { PendingFilesStore } from './pending-files.store';
import {
  adminRequisitesMessage,
  requisitesCreatedReply,
  requisitesErrors,
  requisitesHint,
  requisitesPreview,
} from './requisites.messages';
import { parseRequisites, withoutNumbers } from './requisites.parser';
import { type RequisitesDraft, RequisitesDraftStore } from './requisites-draft.store';

// How long a manager has to answer a requisites report's preview.
const REQUISITES_DRAFT_TTL_MS = 10 * 60_000;

// How long the "кілька номерів / реквізити" mode waits for the message after the button/command.
const REQUISITES_MODE_TTL_MS = 30 * 60_000;

// The "кілька номерів / реквізити" draft: arming the mode, reading a free-text report into a
// preview, and creating the resulting order(s) once the manager confirms it.
@Injectable()
export class RequisitesDraftService {
  constructor(
    private readonly orders: OrdersService,
    private readonly requisites: RequisitesService,
    private readonly orderCreation: OrderCreationFlow,
    private readonly pendingFiles: PendingFilesStore,
    private readonly partOffers: PartOfferStore,
    private readonly drafts: RequisitesDraftStore,
    private readonly sender: TelegramSender,
    private readonly notifier: DraftAttachmentNotifier,
  ) {}

  // Arms the mode: only while armed does the very next message go through the requisites parser
  // instead of the regular single-order template.
  start(userId: bigint): BotReply {
    this.partOffers.delete(userId);
    this.drafts.clearDraft(userId);
    this.drafts.arm(userId, Date.now() + REQUISITES_MODE_TTL_MS);
    return requisitesHint();
  }

  isArmed(userId: bigint): boolean {
    return this.drafts.isArmed(userId);
  }

  // Another flow was started: the next message is no longer a requisites report, and any pending
  // preview is dropped.
  leave(userId: bigint): void {
    this.drafts.leave(userId);
  }

  // Clears any armed mode or pending preview, reporting whether there was anything to clear.
  clear(userId: bigint): boolean {
    const hadWaiting = this.drafts.disarm(userId);
    const hadDraft = this.drafts.clearDraft(userId);
    return hadWaiting || hadDraft;
  }

  edit(userId: bigint): BotReply {
    this.drafts.clearDraft(userId);
    this.drafts.arm(userId, Date.now() + REQUISITES_MODE_TTL_MS);
    return { html: 'Гаразд. Надішліть виправлене повідомлення.' };
  }

  // "Це звичайне замовлення" escape hatch: the message was misread as a requisites report, so the
  // same text goes through the regular template instead.
  async regularFrom(manager: Manager): Promise<BotReply> {
    const draft = this.drafts.takeDraft(manager.telegramId);
    this.drafts.disarm(manager.telegramId);
    if (!draft) {
      return { html: '⚠️ Немає даних. Надішліть замовлення ще раз.' };
    }
    const raw = this.orderCreation.extractFields(draft.text);
    if (!raw) {
      return { html: 'Не вдалося розпізнати як звичайне замовлення. Формат — /new.' };
    }
    return this.orderCreation.process(manager, raw);
  }

  async confirm(manager: Manager): Promise<BotReply> {
    const draft = this.drafts.takeDraft(manager.telegramId);
    if (!draft || draft.expiresAt < Date.now()) {
      return { html: '⚠️ Немає даних для відправки. Надішліть повідомлення ще раз.' };
    }

    try {
      const orders = await this.createOrders(manager, draft);
      this.drafts.disarm(manager.telegramId);
      return requisitesCreatedReply(orders, draft.skipped);
    } catch (error) {
      if (error instanceof OrderNumberTakenError) {
        this.drafts.arm(manager.telegramId, Date.now() + REQUISITES_MODE_TTL_MS);
        return {
          html: `⚠️ Номер ${escapeHtml(error.orderNumber)} щойно з'явився в системі. Надішліть повідомлення ще раз.`,
        };
      }
      throw error;
    }
  }

  async handle(manager: Manager, text: string): Promise<BotReply> {
    const original = text.trim();
    const parsed = parseRequisites(original);
    if (!parsed.ok) {
      return requisitesErrors(parsed.errors);
    }

    let { plan } = parsed;
    let addPart = false;
    let skipped: string[] = [];

    if (plan.kind === 'single') {
      const number = plan.items[0]!.number;
      const existing = await this.orders.findWithBalance(number);
      if (existing) {
        if (existing.order.orderNumber !== normalizeBaseNumber(number)) {
          return {
            html: `⚠️ Номер ${escapeHtml(number)} уже є в системі у складі № ${escapeHtml(existing.order.orderNumber)} — додати до нього не можна.`,
          };
        }
        addPart = true;
      }
    } else if (plan.kind === 'group') {
      const found = await Promise.all(
        plan.items.map((item) => this.orders.findWithBalance(item.number)),
      );
      skipped = plan.items.filter((_, index) => found[index]).map((item) => item.number);
      if (skipped.length === plan.items.length) {
        return {
          html: `⚠️ Усі ці номери вже є в системі: ${skipped.join(', ')}. Немає що додавати.`,
        };
      }
      if (skipped.length > 0) {
        const rest = parseRequisites(withoutNumbers(original, skipped));
        if (!rest.ok) {
          return requisitesErrors(rest.errors);
        }
        plan = rest.plan;
      }
    }

    this.drafts.setDraft(manager.telegramId, {
      plan,
      text: original,
      addPart,
      skipped,
      expiresAt: Date.now() + REQUISITES_DRAFT_TTL_MS,
    });
    return requisitesPreview(plan, {
      addsPart: addPart,
      skipped,
      files: this.pendingFiles.list(manager.telegramId).length,
    });
  }

  pendingUserIds(now: number): bigint[] {
    return this.drafts.pendingUserIds(now);
  }

  private async createOrders(manager: Manager, draft: RequisitesDraft): Promise<Order[]> {
    const { plan } = draft;
    const common = {
      clientName: plan.label,
      exchangeRate: plan.rate ?? undefined,
      comment: plan.comment ?? undefined,
    };

    let orders: Order[];
    if (plan.kind === 'group') {
      orders = await this.orders.createGroup(
        manager.id,
        plan.items.map((item) => ({ orderNumber: item.number, amountDue: item.amount.toFixed(2) })),
        common,
      );
    } else {
      orders = [
        await this.orders.create(
          manager.id,
          {
            ...common,
            orderType: plan.kind === 'minus' ? OrderType.MINUS_CLOSING : OrderType.REGULAR,
            orderNumber: plan.items[0]?.number,
            amountDue: plan.total.toFixed(2),
          },
          { notify: false, addPart: draft.addPart },
        ),
      ];
    }

    const added =
      plan.requisiteLines.length > 0
        ? await this.requisites.addMany(orders[0]!.id, plan.requisiteLines, {
            telegramId: manager.telegramId,
            name: manager.name,
          })
        : [];

    const files = this.pendingFiles.take(manager.telegramId);
    const notice = adminRequisitesMessage(orders, manager.name, added, draft.skipped);
    if (files.length > 0) {
      await this.notifier.notify(orders[0]!, manager, files, notice);
    } else {
      await this.sender.sendToAdmins(notice);
    }
    return orders;
  }
}
