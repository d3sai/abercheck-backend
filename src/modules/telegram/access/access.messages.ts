import { type Manager, ManagerStatus } from '../../../generated/prisma/client';
import type { BotReply } from '../core/bot-reply';
import { escapeHtml } from '../core/format';

export function newManagerNotice(manager: Manager): string {
  return [
    '🆕 <b>Новий менеджер</b>',
    `Ім'я: ${escapeHtml(manager.name)}`,
    `Username: ${manager.username ? `@${escapeHtml(manager.username)}` : '—'}`,
    `Telegram ID: <code>${manager.telegramId}</code>`,
  ].join('\n');
}

export const HELP = [
  'Замовлення надсилайте одним повідомленням, кожне поле з нового рядка:',
  "Номер*, ФОП*, Сума*, Курс, Коментар (* — обов'язкове).",
  '',
  'Кнопки внизу 👇 або команди:',
  '/new — нове замовлення',
  '/newminus — закрити мінус',
  '/requisites — кілька номерів або чужі реквізити',
  '/kit — оплата на Кит',
  '/cash — оплата готівкою',
  '/list — мої відкриті замовлення (/list all — усі)',
  '/cancel — скасувати',
  '',
  'Про оплати повідомлю сюди сам.',
].join('\n');

export function startReply(manager: Manager): BotReply {
  switch (manager.status) {
    case ManagerStatus.ACTIVE:
      return { html: `Вітаю, ${escapeHtml(manager.name)}! 👋\n\n${HELP}`, menu: true };
    case ManagerStatus.PENDING:
      return { html: 'Заявка ще на розгляді. Напишу, щойно її розглянуть.' };
    case ManagerStatus.REJECTED:
      return { html: 'Доступ не надано. Якщо це помилка — зверніться до адміністратора.' };
  }
}

export function decisionNotice(manager: Manager): string {
  return manager.status === ManagerStatus.ACTIVE
    ? `✅ Доступ надано!\n\n${HELP}`
    : 'Заявку відхилено. Якщо це помилка — зверніться до адміністратора.';
}

export const NOT_A_MANAGER =
  'Ця дія доступна лише менеджерам. Надішліть /start, щоб отримати доступ.';
