import type { Context } from 'telegraf';
import type { ForceReply, InlineKeyboardMarkup, ReplyKeyboardRemove } from 'telegraf/types';
import type { BotReply } from './bot-reply';
import { removeKeyboard } from './menu';

export type CommandContext = Context & { payload?: string };
export type MatchContext = Context & { match: RegExpExecArray };

export const isPrivate = (ctx: Context) => ctx.chat?.type === 'private';

export const fullName = (ctx: Context) =>
  [ctx.from?.first_name, ctx.from?.last_name].filter(Boolean).join(' ') || 'Без імені';

function markup({
  buttons,
  forceReply,
  removeKeyboard: clear,
}: BotReply): InlineKeyboardMarkup | ReplyKeyboardRemove | ForceReply | undefined {
  if (forceReply) {
    return { force_reply: true, selective: true, input_field_placeholder: forceReply.placeholder };
  }
  if (clear) {
    return removeKeyboard;
  }
  return buttons ? { inline_keyboard: buttons } : undefined;
}

export async function reply(ctx: Context, botReply: BotReply, replyTo?: number): Promise<void> {
  await ctx.reply(botReply.html, {
    parse_mode: 'HTML',
    link_preview_options: { is_disabled: true },
    reply_markup: markup(botReply),
    reply_parameters: replyTo
      ? { message_id: replyTo, allow_sending_without_reply: true }
      : undefined,
  });
}

export async function edit(ctx: Context, botReply: BotReply): Promise<void> {
  await ctx.editMessageText(botReply.html, {
    parse_mode: 'HTML',
    link_preview_options: { is_disabled: true },
    reply_markup: botReply.buttons ? { inline_keyboard: botReply.buttons } : undefined,
  });
}
