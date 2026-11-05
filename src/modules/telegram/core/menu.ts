import type { ReplyKeyboardMarkup } from 'telegraf/types';

export const MENU_LABEL = {
  MyRequests: '🗂 Мої запити',
  Kit: '💵 Оплата на Кит',
  Cash: '💰 Оплата готівкою',
  Foreign: '🌍 Оплата закордонного замовлення',
  List: '📋 Список',
  Cancel: '❌ Скасувати',
} as const;

// Opens the Mini App from the chat menu button. Not a keyboard button: Telegram gives a Mini App
// opened from a keyboard button no initData, so the form could not authenticate.
export const NEW_REQUEST_LABEL = '📝 Новий запит';

export const mainMenuKeyboard: ReplyKeyboardMarkup = {
  keyboard: [
    [{ text: MENU_LABEL.MyRequests }],
    [{ text: MENU_LABEL.Kit }, { text: MENU_LABEL.Cash }],
    [{ text: MENU_LABEL.Foreign }],
    [{ text: MENU_LABEL.List }, { text: MENU_LABEL.Cancel }],
  ],
  resize_keyboard: true,
};
