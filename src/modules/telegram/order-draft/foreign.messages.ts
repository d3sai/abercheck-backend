import { MAX_FILES_PER_UPLOAD } from '../../attachments/attachments.constants';
import { type BotReply, button } from '../core/bot-reply';
import { escapeHtml, formatKyivDateTime, formatMoneyIn } from '../core/format';
import { MENU_LABEL } from '../core/menu';
import type { ForeignPlan } from './foreign.parser';

export const ForeignAction = {
  Send: 'foreign:ok',
  Edit: 'foreign:edit',
} as const;

function foreignLines(plan: ForeignPlan, exists: boolean): string[] {
  return [
    '🌍 <b>Оплата закордонного замовлення</b>',
    `На кого: ${plan.recipient ? escapeHtml(plan.recipient) : '—'}`,
    `Замовлення: № <b>${escapeHtml(plan.number)}</b>${exists ? ' (уже є в системі)' : ''}`,
    `Сума: <b>${formatMoneyIn(plan.amount, plan.currency)}</b>`,
    `Дата: ${plan.paidAt ? formatKyivDateTime(plan.paidAt) : '—'}`,
    ...(plan.rate ? [`Курс: ${escapeHtml(plan.rate.replace('.', ','))}`] : []),
    ...(plan.comment ? [`Коментар: ${escapeHtml(plan.comment)}`] : []),
  ];
}

export function foreignHint(): BotReply {
  const example = [
    'На кого: Абертайм ТОВ (EUR)',
    '№ 0000-066498',
    'Сума: 100 EUR',
    'Валюта: EUR',
    'Дата: 13.10.2026 15:20',
    'Курс: 44,9',
    'Коментар: за що оплата',
  ].join('\n');
  return {
    html: [
      '🌍 <b>Оплата закордонного замовлення</b>',
      'Надішліть одним повідомленням, кожне поле з нового рядка:',
      '',
      `<pre>${escapeHtml(example)}</pre>`,
      'Валюта: UAH, USD або EUR. «Курс» і «Коментар» можна не писати.',
      '',
      `Файли (до ${MAX_FILES_PER_UPLOAD}) додавайте разом із текстом або перед ним.`,
    ].join('\n'),
  };
}

export function foreignGuard(): BotReply {
  return {
    html: [
      '⚠️ Схоже на оплату закордонного замовлення.',
      `Натисніть «${escapeHtml(MENU_LABEL.Foreign)}» (/foreign) і надішліть це повідомлення ще раз.`,
    ].join('\n'),
  };
}

export function foreignPreview(plan: ForeignPlan, exists: boolean, files: number): BotReply {
  const lines = [
    ...foreignLines(plan, exists),
    '',
    exists
      ? 'Замовлення вже є в системі. Надішлю шаблон адмінам.'
      : 'Створю замовлення й надішлю шаблон адмінам. Оплату не записую.',
    ...(files > 0 ? ['', `Файлів: ${files}`] : []),
    ...(plan.warnings.length > 0 ? ['', ...plan.warnings.map((w) => `⚠️ ${escapeHtml(w)}`)] : []),
  ];
  return {
    html: lines.join('\n'),
    buttons: [
      [button('✅ Надіслати', ForeignAction.Send), button('✏️ Виправити', ForeignAction.Edit)],
    ],
  };
}

export function foreignCreatedReply(plan: ForeignPlan): BotReply {
  return {
    html: [
      `✅ «Оплата закордонного замовлення» надіслано адмінам · ${formatMoneyIn(plan.amount, plan.currency)}`,
      `Замовлення: № <b>${escapeHtml(plan.number)}</b>`,
    ].join('\n'),
  };
}

export function adminForeignMessage(
  plan: ForeignPlan,
  exists: boolean,
  managerName: string,
  now = new Date(),
): string {
  return [
    ...foreignLines(plan, exists),
    '',
    `Менеджер: ${escapeHtml(managerName)}`,
    `Створено: ${formatKyivDateTime(now)}`,
  ].join('\n');
}
