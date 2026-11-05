import { Injectable } from '@nestjs/common';
import type { Context } from 'telegraf';
import type { Message } from 'telegraf/types';
import { type FinanceRequestCard, Prisma } from '../../generated/prisma/client';
import { isRecordNotFound } from '../../common/prisma/prisma-errors';
import { escapeHtml } from '../telegram/core/format';
import { formatRate } from '../telegram/notifications/order-templates';
import type { MatchContext } from '../telegram/core/telegram-context';
import { TelegramSender } from '../telegram/core/telegram-sender';
import { parseExchangeRate } from '../telegram/order-draft/order-draft.parsers';
import { CARD, IBAN, loneRate } from '../telegram/order-draft/requisites.parser';
import { FinanceClient } from './finance.client';
import { FinanceApiError, type FinanceRequestView } from './finance.types';
import { acceptRefusal } from './request-card.messages';
import { RequestCardsRepository } from './request-cards.repository';
import { RequestSyncService } from './request-sync.service';

type Next = () => Promise<void>;

const PROMPT = /^Курс для запиту #(.+):$/;

/** Group-chat actions of a financier: pick a FOP, set a rate, send payouts, refresh. */
const FOP_NAME = /^\s*(?:ФОП|ТОВ|FOP)[\s.:,-]+\S.{0,60}$/iu;

@Injectable()
export class FinancierActionsService {
  constructor(
    private readonly sender: TelegramSender,
    private readonly finance: FinanceClient,
    private readonly cards: RequestCardsRepository,
    private readonly sync: RequestSyncService,
  ) {}

  async pressFop(ctx: MatchContext): Promise<void> {
    const card = await this.cardOfPress(ctx);
    if (!card || !ctx.from) return;
    let view: FinanceRequestView;
    try {
      view = await this.finance.accept(card.requestId, {
        responderTelegramId: ctx.from.id,
        fopId: Number(ctx.match[2]),
        exchangeRate: card.pendingRate ? Number(card.pendingRate) : undefined,
      });
    } catch (error) {
      if (!(error instanceof FinanceApiError)) throw error;
      await ctx.answerCbQuery(acceptRefusal(error.code, error.details, error.status), {
        show_alert: true,
      });
      await this.redraw(card);
      return;
    }
    await this.sync.renderGroup(await this.setRate(card, null), view);
    await ctx.answerCbQuery('✅ Прийнято');
    await this.sync.notifyManager(view);
  }

  async askRate(ctx: MatchContext): Promise<void> {
    const card = await this.cardOfPress(ctx);
    if (!card) return;
    await ctx.answerCbQuery();
    // not `selective`: the prompt replies to the bot's own card, so selective would target nobody
    await ctx.reply(`Курс для запиту #${escapeHtml(card.number)}:`, {
      parse_mode: 'HTML',
      reply_parameters: { message_id: card.groupMessageId, allow_sending_without_reply: true },
      reply_markup: { force_reply: true, input_field_placeholder: '44,9' },
    });
  }

  async refresh(ctx: MatchContext): Promise<void> {
    const card = await this.cardOfPress(ctx);
    if (!card) return;
    try {
      const { request } = await this.finance.get(card.requestId);
      await ctx.answerCbQuery();
      await this.sync.renderGroup(card, request);
    } catch (error) {
      if (!(error instanceof FinanceApiError)) throw error;
      await ctx.answerCbQuery(acceptRefusal(error.code, error.details, error.status), {
        show_alert: true,
      });
    }
  }

  /** Handles only replies to a card or to the rate prompt; everything else stays ordinary chat. */
  async onText(ctx: Context, next: Next): Promise<void> {
    const message = ctx.message;
    const target = message && 'reply_to_message' in message ? message.reply_to_message : undefined;
    const text = ctx.text;
    if (!text || text.startsWith('/') || !target || !ctx.from || !this.inAdminChat(ctx)) {
      return next();
    }
    const card = await this.cardOfReply(ctx, target);
    if (!card) return next();

    // `loneRate` keeps ordinary numbers in a reply (a quantity, a year) from becoming a rate
    const lone = loneRate(text);
    const rate = lone === null ? null : parseExchangeRate(lone);
    if (rate?.ok) return this.storeRate(ctx, card, rate.value);
    if (CARD.test(text) || IBAN.test(text))
      return this.acceptReply(ctx, card, { payoutsText: text });
    // the most common answer in the old finance bot: just a FOP name («Фоп Гук)»)
    if (FOP_NAME.test(text)) return this.acceptReply(ctx, card, { fopName: text.trim() });
    return next();
  }

  private async storeRate(ctx: Context, card: FinanceRequestCard, value: string): Promise<void> {
    try {
      const { request } = await this.finance.get(card.requestId);
      if (request.status !== 'pending') {
        await this.say(
          ctx,
          request.status === 'accepted'
            ? 'Запит уже прийнято — курс змініть у кабінеті.'
            : 'Запит уже закрито.',
        );
        return;
      }
      await this.sync.renderGroup(await this.setRate(card, value), request);
      await this.say(
        ctx,
        `Курс ${formatRate(new Prisma.Decimal(value))} буде застосовано при прийнятті.`,
      );
    } catch (error) {
      await this.refuse(ctx, error);
    }
  }

  private async acceptReply(
    ctx: Context,
    card: FinanceRequestCard,
    answer: { payoutsText: string } | { fopName: string },
  ): Promise<void> {
    let view: FinanceRequestView;
    try {
      view = await this.finance.accept(card.requestId, {
        responderTelegramId: ctx.from!.id,
        ...answer,
        exchangeRate: card.pendingRate ? Number(card.pendingRate) : undefined,
      });
    } catch (error) {
      await this.refuse(ctx, error);
      return;
    }
    await this.sync.renderGroup(await this.setRate(card, null), view);
    await this.sync.notifyManager(view);
  }

  private async refuse(ctx: Context, error: unknown): Promise<void> {
    if (!(error instanceof FinanceApiError)) throw error;
    await this.say(ctx, escapeHtml(acceptRefusal(error.code, error.details, error.status)));
  }

  private inAdminChat(ctx: Context): boolean {
    return ctx.chat?.id === this.sender.adminChatId;
  }

  private async cardOfPress(ctx: MatchContext): Promise<FinanceRequestCard | null> {
    if (!this.inAdminChat(ctx)) return null;
    const card = await this.cards.byRequestId(ctx.match[1]!);
    if (!card) await ctx.answerCbQuery('Запит не знайдено', { show_alert: true });
    return card;
  }

  private cardOfReply(
    ctx: Context,
    target: NonNullable<Message.CommonMessage['reply_to_message']>,
  ): Promise<FinanceRequestCard | null> {
    const chatId = BigInt(ctx.chat!.id);
    const prompt = 'text' in target ? PROMPT.exec(target.text) : null;
    return prompt && target.from?.id === ctx.botInfo.id
      ? this.cards.byNumber(chatId, prompt[1]!)
      : this.cards.byGroupMessage(chatId, target.message_id);
  }

  /** Redraws from finance's truth; a failed redraw must not hide the refusal already shown. */
  private async redraw(card: FinanceRequestCard): Promise<void> {
    try {
      await this.sync.renderGroup(card, (await this.finance.get(card.requestId)).request);
    } catch (error) {
      if (!(error instanceof FinanceApiError)) throw error;
    }
  }

  /** `setPendingRate` throws P2025 if the row is gone; the group message is still worth redrawing. */
  private async setRate(
    card: FinanceRequestCard,
    pendingRate: string | null,
  ): Promise<FinanceRequestCard> {
    if (card.pendingRate === pendingRate) return card;
    try {
      return await this.cards.setPendingRate(card.requestId, pendingRate);
    } catch (error) {
      if (isRecordNotFound(error)) return { ...card, pendingRate };
      throw error;
    }
  }

  private async say(ctx: Context, html: string): Promise<void> {
    // no `message_thread_id`: ctx.reply adds it for a topic message only, and a plain reply thread id would be rejected
    await ctx.reply(html, {
      parse_mode: 'HTML',
      reply_parameters: { message_id: ctx.message!.message_id, allow_sending_without_reply: true },
    });
  }
}
