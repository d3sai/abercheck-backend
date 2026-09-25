import { MAX_FILES_PER_UPLOAD } from '../../attachments/attachments.constants';
import { type BotReply, button } from '../core/bot-reply';
import { escapeHtml, formatKyivDateTime, formatMoneyIn as money } from '../core/format';
import type { CashPlan } from './cash.parser';

export const CashAction = {
  Send: 'cash:ok',
  Edit: 'cash:edit',
} as const;

// Reads like the "Оплата готівкою" template the managers fill in.
function cashLines(plan: CashPlan, exists: boolean): string[] {
  return [
    '💰 <b>Оплата готівкою</b>',
    `Замовлення: № <b>${escapeHtml(plan.number)}</b>${exists ? ' (уже є в системі)' : ''}`,
    `Дата: ${plan.paidAt ? formatKyivDateTime(plan.paidAt) : '—'}`,
    `Сума: <b>${money(plan.amount, plan.currency)}</b>`,
    ...(plan.rate ? [`Курс: ${escapeHtml(plan.rate.replace('.', ','))}`] : []),
    `Ким передано: ${plan.handedBy ? escapeHtml(plan.handedBy) : '—'}`,
  ];
}

export function cashHint(): BotReply {
  const example = [
    'Замовлення: 0000-066498',
    'Дата: 01.09.2026 15:20',
    'Сума: 4260 грн',
    'Курс: 44,9',
    'Ким передано: Христина Павлів передала готівку Христині Вихопень (Саджениці)',
  ].join('\n');
  return {
    html: [
      '💰 <b>Оплата готівкою</b>',
      'Надішліть одним повідомленням. Підписи полів можна не писати, кожне поле з нового рядка:',
      '',
      `<pre>${escapeHtml(example)}</pre>`,
      'Суму в доларах пишіть зі знаком $: <code>150 $</code>.',
      '',
      `Файли (до ${MAX_FILES_PER_UPLOAD}) додавайте разом із текстом або перед ним.`,
    ].join('\n'),
  };
}

export function cashPreview(plan: CashPlan, exists: boolean, files: number): BotReply {
  const lines = [
    '<b>Зрозумів так:</b>',
    '',
    ...cashLines(plan, exists),
    '',
    exists
      ? 'Запишу оплату до цього замовлення.'
      : 'Створю це замовлення й одразу запишу на нього оплату.',
    ...(files > 0 ? ['', `Файлів: ${files}`] : []),
    ...(plan.warnings.length > 0 ? ['', ...plan.warnings.map((w) => `⚠️ ${escapeHtml(w)}`)] : []),
  ];
  return {
    html: lines.join('\n'),
    buttons: [[button('✅ Надіслати', CashAction.Send), button('✏️ Виправити', CashAction.Edit)]],
  };
}

export function cashCreatedReply(plan: CashPlan): BotReply {
  return {
    html: `💰 Оплату готівкою записано: № <b>${escapeHtml(plan.number)}</b> · ${money(plan.amount, plan.currency)}`,
  };
}

export function adminCashMessage(
  plan: CashPlan,
  exists: boolean,
  managerName: string,
  now = new Date(),
): string {
  return [
    ...cashLines(plan, exists),
    '',
    `Менеджер: ${escapeHtml(managerName)}`,
    `Створено: ${formatKyivDateTime(now)}`,
  ].join('\n');
}
