import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { ApiError, type ApiErrorBody } from '../../common/api-error';
import type { Manager, PendingOrder } from '../../generated/prisma/client';
import { PendingOrdersRepository, storedFiles } from '../finance-sync/pending-orders.repository';
import { ManagersService } from '../managers/managers.service';
import { NOT_A_MANAGER } from '../telegram/access/access.messages';
import { TelegramSender } from '../telegram/core/telegram-sender';
import { edit, isPrivate, type MatchContext } from '../telegram/core/telegram-context';
import { type DirectOrdersResult, DirectOrdersService } from './direct-orders.service';
import type { OrderPlan } from './miniapp.dto';
import { fromStoredPlan, toStoredPlan } from './pending-order-plan';
import {
  acceptedCard,
  ATTACH_PROMPT,
  CANCELLED_CARD,
  pendingOrderButtons,
} from './pending-order.messages';

// Telegram caps an alert at 200 characters
const alert = (text: string) => [text.slice(0, 200), { show_alert: true }] as const;

const NOT_FOUND = 'Запит не знайдено';

/** A Kit, cash or foreign order from the form waits here in the manager's chat until «Прийняти». */
@Injectable()
export class PendingOrdersService {
  private readonly logger = new Logger(PendingOrdersService.name);

  constructor(
    private readonly drafts: PendingOrdersRepository,
    private readonly directOrders: DirectOrdersService,
    private readonly sender: TelegramSender,
    private readonly managers: ManagersService,
  ) {}

  async submit(manager: Manager, order: OrderPlan): Promise<DirectOrdersResult> {
    const card = await this.directOrders.preview(order);
    const draft = await this.drafts.create({
      managerId: manager.id,
      managerChatId: manager.telegramId,
      plan: toStoredPlan(order),
    });
    const messageId = await this.sender.send(
      manager.telegramId,
      card.html,
      pendingOrderButtons(draft.id),
    );
    if (messageId === null) {
      await this.drafts.remove(draft.id);
      throw new ApiError(
        HttpStatus.BAD_GATEWAY,
        'card-not-sent',
        'Не вдалося надіслати картку в чат бота. Спробуйте ще раз.',
      );
    }
    await this.drafts.setMessage(draft.id, messageId);
    return {
      orderNumbers: [],
      skipped: [],
      note: 'Картку надіслано в чат бота: додайте файли й натисніть «Прийняти».',
    };
  }

  /** The manager and draft of a press; anything else is answered here and gives null. */
  private async own(ctx: MatchContext): Promise<{ manager: Manager; draft: PendingOrder } | null> {
    if (!isPrivate(ctx) || !ctx.from) return null;
    const manager = await this.managers.findActiveByTelegramId(BigInt(ctx.from.id));
    if (!manager) {
      await ctx.answerCbQuery(...alert(NOT_A_MANAGER));
      return null;
    }
    const draft = await this.drafts.byId(ctx.match[1]!);
    if (draft?.managerChatId !== BigInt(ctx.chat!.id)) {
      await ctx.answerCbQuery(...alert(NOT_FOUND));
      return null;
    }
    return { manager, draft };
  }

  async accept(ctx: MatchContext): Promise<void> {
    const found = await this.own(ctx);
    if (!found) return;
    const claimed = await this.drafts.claim(found.draft.id);
    if (!claimed) {
      await ctx.answerCbQuery(...alert(NOT_FOUND));
      return;
    }
    const order = fromStoredPlan(claimed.plan);
    if (!order) {
      this.logger.error(`Pending order ${claimed.id} has an unreadable plan`);
      await ctx.answerCbQuery(...alert('Не вдалося прочитати дані. Створіть замовлення ще раз.'));
      return;
    }
    try {
      // the card text as it was sent, so it stays on screen after the order is made
      const card = await this.directOrders.preview(order);
      const result = await this.directOrders.create(
        found.manager,
        order,
        storedFiles(claimed.files),
      );
      await edit(ctx, acceptedCard(card.html, result.orderNumbers)).catch(() => undefined);
      // a reply to the accepted card brings files to the first order, as on a request's card
      const first = result.orderNumbers[0];
      if (first && claimed.managerMessageId !== null) {
        await this.drafts.remember(
          claimed.managerChatId,
          claimed.managerMessageId,
          `order:${first}`,
        );
      }
      await (result.note
        ? ctx.answerCbQuery(...alert(result.note))
        : ctx.answerCbQuery('✅ Оформлено'));
    } catch (error) {
      await this.drafts.restore(claimed);
      if (error instanceof ApiError) {
        await ctx.answerCbQuery(...alert((error.getResponse() as ApiErrorBody).message));
        return;
      }
      this.logger.error(`Accepting pending order ${claimed.id} failed`, error);
      await ctx.answerCbQuery(...alert('Не вдалося, спробуйте ще раз'));
    }
  }

  async cancel(ctx: MatchContext): Promise<void> {
    const found = await this.own(ctx);
    if (!found) return;
    await this.drafts.remove(found.draft.id);
    await edit(ctx, CANCELLED_CARD).catch(() => undefined);
    await ctx.answerCbQuery('❌ Скасовано');
  }

  /** A force-reply prompt, so the files sent next are replies and reach the draft through the receipts flow. */
  async askFiles(ctx: MatchContext): Promise<void> {
    const found = await this.own(ctx);
    if (!found) return;
    await ctx.answerCbQuery();
    const prompt = await ctx.reply(ATTACH_PROMPT, {
      reply_markup: { force_reply: true, input_field_placeholder: 'Фото або файл квитанції' },
    });
    await this.drafts.remember(found.draft.managerChatId, prompt.message_id, found.draft.id);
  }
}
