import { type Manager, ManagerStatus } from '../../../generated/prisma/client';
import type { BotReply } from '../core/bot-reply';
import { escapeHtml } from '../core/format';
import { MY_ORDERS_LABEL, MY_REQUESTS_LABEL, NEW_REQUEST_LABEL } from '../core/menu';

export function newManagerNotice(manager: Manager): string {
  return [
    '🆕 <b>Новий менеджер</b>',
    `Ім'я: ${escapeHtml(manager.name)}`,
    `Username: ${manager.username ? `@${escapeHtml(manager.username)}` : '—'}`,
    `Telegram ID: <code>${manager.telegramId}</code>`,
  ].join('\n');
}

export const HELP = [
  `Оплати створюються кнопкою «${NEW_REQUEST_LABEL}» біля поля введення повідомлення.`,
  `Свої запити й замовлення — кнопки «${MY_REQUESTS_LABEL}» і «${MY_ORDERS_LABEL}».`,
  '',
  '/cancel — скасувати незавершену дію',
  '/video — відео-інструкції',
  '',
  'Про оплати повідомлю сюди сам.',
].join('\n');

export function startReply(manager: Manager): BotReply {
  switch (manager.status) {
    case ManagerStatus.ACTIVE:
      return { html: `Вітаю, ${escapeHtml(manager.name)}! 👋\n\n${HELP}`, keyboard: true };
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
