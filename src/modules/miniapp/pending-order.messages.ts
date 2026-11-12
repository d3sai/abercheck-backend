import { type BotReply, button } from '../telegram/core/bot-reply';
import { escapeHtml } from '../telegram/core/format';
import { attachOrderButton, cancelOrderButton } from '../telegram/orders-list/orders-list.messages';

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

/** The card as it was sent, with the outcome under it and a way to cancel each order it made. */
export const acceptedCard = (cardHtml: string, orderNumbers: string[]): BotReply => ({
  html: `${cardHtml}\n\n${
    orderNumbers.length > 0
      ? `✅ Оформлено: № ${escapeHtml(orderNumbers.join(', '))}`
      : '✅ Прийнято'
  }`,
  buttons: [
    ...(orderNumbers[0] ? [[attachOrderButton(orderNumbers[0])]] : []),
    ...orderNumbers.map((number) => [cancelOrderButton(number)]),
  ],
});

export const CANCELLED_CARD: BotReply = { html: '❌ Скасовано' };
