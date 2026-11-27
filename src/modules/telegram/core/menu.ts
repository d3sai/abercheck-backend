import type { ReplyKeyboardMarkup } from 'telegraf/types';

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

export const GUIDES_LABEL = '🎬 Відео-інструкції';
export const MY_REQUESTS_LABEL = MENU_LABEL.MyRequests;
export const MY_ORDERS_LABEL = '📋 Мої замовлення';

// Replaces the old reply keyboard in existing users' chats; the user can collapse it.
export const mainKeyboard: ReplyKeyboardMarkup = {
  keyboard: [[{ text: MY_REQUESTS_LABEL }, { text: MY_ORDERS_LABEL }], [{ text: GUIDES_LABEL }]],
  resize_keyboard: true,
  is_persistent: false,
};

// Bump to push mainKeyboard to every active manager on the next restart.
export const KEYBOARD_VERSION = 2;
export const KEYBOARD_NOTICE = `Свої запити й замовлення тепер видно під кнопками «${MY_REQUESTS_LABEL}» і «${MY_ORDERS_LABEL}» внизу. Сховати кнопки можна іконкою ⌨️ біля поля введення.`;
