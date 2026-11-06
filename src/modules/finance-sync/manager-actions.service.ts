import { Injectable } from '@nestjs/common';
import type { Context } from 'telegraf';
import type { FinanceRequestCard } from '../../generated/prisma/client';
import { NOT_A_MANAGER } from '../telegram/access/access.messages';
import { fullName, isPrivate, type MatchContext, reply } from '../telegram/core/telegram-context';
import { ManagersService } from '../managers/managers.service';
import { FinanceClient } from './finance.client';
import { FinanceApiError } from './finance.types';
import { RequestCardsRepository } from './request-cards.repository';
import { RequestSyncService } from './request-sync.service';

type Next = () => Promise<void>;

const NOT_ANSWERED = 'Фінанси не відповіли, спробуйте ще раз';

/** Private-chat actions of a manager: cancel a request, answer the financiers, list the requests. */
@Injectable()
export class ManagerActionsService {
  constructor(
    private readonly finance: FinanceClient,
    private readonly cards: RequestCardsRepository,
    private readonly sync: RequestSyncService,
    private readonly managers: ManagersService,
  ) {}

  /**
   * «📎 Прикріпити файли»: a force-reply prompt, so the files the manager sends next are replies to it and
   * reach the request through the receipts flow — straight from Telegram, without an upload through us.
   */
  async askFiles(ctx: MatchContext): Promise<void> {
    if (!isPrivate(ctx) || !ctx.from) return;
    const card = await this.cards.byRequestId(ctx.match[1]!);
    if (card?.managerChatId !== BigInt(ctx.chat!.id)) {
      await ctx.answerCbQuery('Запит не знайдено', { show_alert: true });
      return;
    }
    if (!(await this.managers.findActiveByTelegramId(BigInt(ctx.from.id)))) {
      await ctx.answerCbQuery(NOT_A_MANAGER, { show_alert: true });
      return;
    }
    await ctx.answerCbQuery();
    const prompt = await ctx.reply(
      `📎 Запит #${card.number}: надішліть фото або файли відповіддю на це повідомлення. Можна кілька.`,
      {
        reply_markup: { force_reply: true, input_field_placeholder: 'Фото або файл квитанції' },
      },
    );
    await this.cards.rememberChatMessage(card.managerChatId, prompt.message_id, card.requestId);
  }

  async cancel(ctx: MatchContext): Promise<void> {
    if (!isPrivate(ctx) || !ctx.from) return;
    if (!(await this.managers.findActiveByTelegramId(BigInt(ctx.from.id)))) {
      await ctx.answerCbQuery(NOT_A_MANAGER, { show_alert: true });
      return;
    }
    const card = await this.cards.byRequestId(ctx.match[1]!);
    if (card?.managerChatId !== BigInt(ctx.chat!.id)) {
      await ctx.answerCbQuery('Запит не знайдено', { show_alert: true });
      return;
    }
    try {
      const view = await this.finance.cancel(card.requestId, {
        actorTelegramId: ctx.from.id,
        actorName: fullName(ctx),
      });
      await this.sync.renderManager(card, view);
      await this.sync.renderGroup(card, view);
      await ctx.answerCbQuery('❌ Скасовано');
      await this.sync.notifyManager(view);
    } catch (error) {
      if (!(error instanceof FinanceApiError)) throw error;
      const closed = error.status === 409;
      await ctx.answerCbQuery(closed ? 'Запит уже закрито' : NOT_ANSWERED, { show_alert: true });
      if (closed) await this.redraw(card);
    }
  }

  /** Handles only replies to a manager card or to a relayed «💬» message; the rest is ordinary chat. */
  async onText(ctx: Context, next: Next): Promise<void> {
    const message = ctx.message;
    const target = message && 'reply_to_message' in message ? message.reply_to_message : undefined;
    const text = ctx.text;
    if (!text || text.startsWith('/') || !target || !ctx.from || !isPrivate(ctx)) return next();

    const chatId = BigInt(ctx.chat!.id);
    const requestId =
      (await this.cards.byManagerMessage(chatId, target.message_id))?.requestId ??
      (await this.cards.requestOfChatMessage(chatId, target.message_id));
    if (!requestId) return next();

    if (!(await this.managers.findActiveByTelegramId(BigInt(ctx.from.id)))) {
      await reply(ctx, { html: NOT_A_MANAGER }, message!.message_id);
      return;
    }
    try {
      await this.finance.postMessage(requestId, {
        authorTelegramId: ctx.from.id,
        authorName: fullName(ctx),
        body: text,
        clientId: `tg-${chatId}-${message!.message_id}`,
      });
    } catch (error) {
      if (!(error instanceof FinanceApiError)) throw error;
      await reply(
        ctx,
        {
          html:
            error.status === 409
              ? 'Запит закрито, повідомлення не надіслано'
              : 'Фінанси не відповіли, повідомлення не надіслано',
        },
        message!.message_id,
      );
      return;
    }
    // 👍, not ✅: bots may only use telegram's fixed reaction set, and ✅ is not in it
    await ctx
      .react('👍')
      .catch(() => reply(ctx, { html: 'Надіслано фінансистам.' }, message!.message_id));
  }

  /** A failed redraw must not hide the refusal already shown. */
  private async redraw(card: FinanceRequestCard): Promise<void> {
    try {
      await this.sync.renderManager(card, (await this.finance.get(card.requestId)).request);
    } catch (error) {
      if (!(error instanceof FinanceApiError)) throw error;
    }
  }
}
