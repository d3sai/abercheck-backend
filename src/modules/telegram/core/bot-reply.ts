import type { InlineKeyboardButton } from 'telegraf/types';

export const BOT_RESTART_NOTICE =
  '⚠️ Бот перезапускається на оновлення. Якщо ви щойно щось надсилали або чекали на відповідь — повторіть за хвилину.';

export interface BotReply {
  html: string;
  buttons?: InlineKeyboardButton[][];
  forceReply?: { placeholder: string };
  /** Shows the reply keyboard with the guides button. */
  keyboard?: boolean;
}

export const button = (text: string, callbackData: string): InlineKeyboardButton => ({
  text,
  callback_data: callbackData,
});

export const mention = (userId: number | bigint, htmlName: string): string =>
  `<a href="tg://user?id=${userId}">${htmlName}</a>`;

export const PAGE_SIZE = 5;

/** Pages of a list in one message: «◀️ Назад» / «Далі ▶️» edit it in place via `${prefix}:<page>`. */
export const pageCount = (total: number) => Math.max(1, Math.ceil(total / PAGE_SIZE));

export const pageNav = (prefix: string, index: number, pages: number): InlineKeyboardButton[] => [
  ...(index > 0 ? [button('◀️ Назад', `${prefix}:${index - 1}`)] : []),
  ...(index < pages - 1 ? [button('Далі ▶️', `${prefix}:${index + 1}`)] : []),
];
