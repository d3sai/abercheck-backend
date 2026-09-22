import type { InlineKeyboardButton } from 'telegraf/types';

// Sent to anyone with an unfinished flow (a pending file, a draft, a prompt waiting for a reply)
// when the bot is about to restart, so the loss is visible instead of silent.
export const BOT_RESTART_NOTICE =
  '⚠️ Бот перезапускається на оновлення. Якщо ви щойно щось надсилали або чекали на відповідь — повторіть за хвилину.';

export interface BotReply {
  html: string;
  buttons?: InlineKeyboardButton[][];
  forceReply?: { placeholder: string };
  /** Attach the persistent main-menu keyboard to this message. */
  menu?: boolean;
}

export const button = (text: string, callbackData: string): InlineKeyboardButton => ({
  text,
  callback_data: callbackData,
});

export const mention = (userId: number | bigint, htmlName: string): string =>
  `<a href="tg://user?id=${userId}">${htmlName}</a>`;
