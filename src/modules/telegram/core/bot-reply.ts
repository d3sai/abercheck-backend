import type { InlineKeyboardButton } from 'telegraf/types';

export const BOT_RESTART_NOTICE =
  '⚠️ Бот перезапускається на оновлення. Якщо ви щойно щось надсилали або чекали на відповідь — повторіть за хвилину.';

export interface BotReply {
  html: string;
  buttons?: InlineKeyboardButton[][];
  forceReply?: { placeholder: string };
  menu?: boolean;
}

export const button = (text: string, callbackData: string): InlineKeyboardButton => ({
  text,
  callback_data: callbackData,
});

export const mention = (userId: number | bigint, htmlName: string): string =>
  `<a href="tg://user?id=${userId}">${htmlName}</a>`;
