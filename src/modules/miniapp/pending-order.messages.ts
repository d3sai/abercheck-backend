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

export const acceptedCard = (orderNumbers: string[]): BotReply => ({
  html:
    orderNumbers.length > 0
      ? `✅ Оформлено: № ${escapeHtml(orderNumbers.join(', '))}`
      : '✅ Прийнято',
});

export const CANCELLED_CARD: BotReply = { html: '❌ Скасовано' };
