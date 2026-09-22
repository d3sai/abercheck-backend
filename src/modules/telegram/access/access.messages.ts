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
  'Щоб створити замовлення — надішліть одним повідомленням кожне значення з нового рядка:',
  "Номер*, ФОП*, Сума*, Курс, Коментар (* — обов'язкове).",
  '',
  'Керуйте кнопками знизу 👇 або командами:',
  '/new — формат нового замовлення',
  '/newminus — формат закриття мінусу (без номера)',
  '/requisites — кілька номерів або оплата на чужі реквізити одним повідомленням',
  '/list — мої відкриті замовлення (/list all — усі)',
  '/cancel — забути прикріплені файли',
  '',
  'Про оплати за вашими замовленнями повідомлю сюди автоматично.',
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
