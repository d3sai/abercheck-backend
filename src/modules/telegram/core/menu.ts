import type { ReplyKeyboardRemove } from 'telegraf/types';

// The buttons the reply keyboard used to carry. Kept to recognise a press from a keyboard
// that is still on someone's screen.
export const MENU_LABEL = {
  MyRequests: '🗂 Мої запити',
  NewOrder: '📝 Нове замовлення',
  NewMinus: '➖ Закрити мінус',
  Requisites: '💳 Кілька номерів / реквізити',
  Kit: '💵 Оплата на Кит',
  Cash: '💰 Оплата готівкою',
  Foreign: '🌍 Оплата закордонного замовлення',
  List: '📋 Список',
  Cancel: '❌ Скасувати',
} as const;

// Opens the Mini App from the chat menu button. Not a keyboard button: Telegram gives a Mini App
// opened from a keyboard button no initData, so the form could not authenticate.
export const NEW_REQUEST_LABEL = '📝 Новий запит';

// The bot has no reply keyboard any more; this clears the old one from existing users' chats.
export const removeKeyboard: ReplyKeyboardRemove = { remove_keyboard: true };
