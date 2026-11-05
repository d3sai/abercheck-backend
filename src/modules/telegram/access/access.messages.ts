import { type Manager, ManagerStatus } from '../../../generated/prisma/client';
import type { BotReply } from '../core/bot-reply';
import { escapeHtml } from '../core/format';
import { NEW_REQUEST_LABEL } from '../core/menu';

export function newManagerNotice(manager: Manager): string {
  return [
    '🆕 <b>Новий менеджер</b>',
    `Ім'я: ${escapeHtml(manager.name)}`,
    `Username: ${manager.username ? `@${escapeHtml(manager.username)}` : '—'}`,
    `Telegram ID: <code>${manager.telegramId}</code>`,
  ].join('\n');
}

export const HELP = [
  `Нові запити на оплату — кнопка «${NEW_REQUEST_LABEL}» біля поля повідомлення.`,
  '',
  'Кнопки внизу 👇 або команди:',
  '/kit — оплата на Кит',
  '/cash — оплата готівкою',
  '/foreign — оплата закордонного замовлення',
  '/requests — мої запити до фінансистів',
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
