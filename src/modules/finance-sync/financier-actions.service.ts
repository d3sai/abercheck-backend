import { Injectable } from '@nestjs/common';
import type { Context } from 'telegraf';
import type { Message } from 'telegraf/types';
import type { FinanceRequestCard } from '../../generated/prisma/client';
import { escapeHtml } from '../telegram/core/format';
import type { MatchContext } from '../telegram/core/telegram-context';
import { TelegramSender } from '../telegram/core/telegram-sender';
import { CARD, IBAN } from '../telegram/order-draft/requisites.parser';
import { FinanceClient } from './finance.client';
import { FinanceApiError, type FinanceRequestView } from './finance.types';
import { acceptRefusal } from './request-card.messages';
import { RequestCardsRepository } from './request-cards.repository';
import { RequestSyncService } from './request-sync.service';

type Next = () => Promise<void>;

/** Group-chat actions of a financier: pick a FOP, send payouts, refresh. */
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
      });
    } catch (error) {
      if (!(error instanceof FinanceApiError)) throw error;
      await ctx.answerCbQuery(acceptRefusal(error.code, error.details, error.status), {
        show_alert: true,
      });
      await this.redraw(card);
      return;
    }
    await this.sync.renderGroup(card, view);
    await ctx.answerCbQuery('✅ Прийнято');
    await this.sync.notifyManager(view);
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

  /** Handles only replies to a card; everything else stays ordinary chat. */
  async onText(ctx: Context, next: Next): Promise<void> {
    const message = ctx.message;
    const target = message && 'reply_to_message' in message ? message.reply_to_message : undefined;
    const text = ctx.text;
    if (!text || text.startsWith('/') || !target || !ctx.from || !this.inAdminChat(ctx)) {
      return next();
    }
    const card = await this.cardOfReply(ctx, target);
    if (!card) return next();

    if (CARD.test(text) || IBAN.test(text))
      return this.acceptReply(ctx, card, { payoutsText: text });
    // the most common answer in the old finance bot: just a FOP name («Фоп Гук)»)
    if (FOP_NAME.test(text)) return this.acceptReply(ctx, card, { fopName: text.trim() });
    return next();
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
      });
    } catch (error) {
      await this.refuse(ctx, error);
      return;
    }
    await this.sync.renderGroup(card, view);
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
    return this.cards.byGroupMessage(BigInt(ctx.chat!.id), target.message_id);
  }

  /** Redraws from finance's truth; a failed redraw must not hide the refusal already shown. */
  private async redraw(card: FinanceRequestCard): Promise<void> {
    try {
      await this.sync.renderGroup(card, (await this.finance.get(card.requestId)).request);
    } catch (error) {
      if (!(error instanceof FinanceApiError)) throw error;
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
