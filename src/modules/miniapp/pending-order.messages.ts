import { type BotReply, button } from '../telegram/core/bot-reply';
import { escapeHtml } from '../telegram/core/format';

export const PendingOrderAction = {
  Accept: /^po:a:([\w-]+)$/,
  /** «📎 Прикріпити файли»: the bot asks for the files as a reply; they are held on the draft. */
  Attach: /^po:f:([\w-]+)$/,
  Cancel: /^po:c:([\w-]+)$/,
} as const;

export const pendingOrderButtons = (id: string) => [
  [button('📎 Прикріпити файли', `po:f:${id}`)],
  [button('✅ Прийняти', `po:a:${id}`), button('✖ Скасувати', `po:c:${id}`)],
];

export const ATTACH_PROMPT = '📎 Надішліть фото або файл відповіддю на це повідомлення.';

/** The card as it was sent, now without buttons and with the outcome under it. */
export const acceptedCard = (cardHtml: string, orderNumbers: string[]): BotReply => ({
  html: `${cardHtml}\n\n${
    orderNumbers.length > 0
      ? `✅ Оформлено: № ${escapeHtml(orderNumbers.join(', '))}`
      : '✅ Прийнято'
  }`,
});

export const CANCELLED_CARD: BotReply = { html: '❌ Скасовано' };
