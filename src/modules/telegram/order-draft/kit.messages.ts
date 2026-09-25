import { Currency, type Prisma } from '../../../generated/prisma/client';
import { MAX_FILES_PER_UPLOAD } from '../../attachments/attachments.constants';
import { type BotReply, button } from '../core/bot-reply';
import { escapeHtml, formatKyivDateTime, formatMoneyIn } from '../core/format';
import type { KitPlan } from './kit.parser';

export const KitAction = {
  Send: 'kit:ok',
  Edit: 'kit:edit',
} as const;

const usd = (value: Prisma.Decimal): string => formatMoneyIn(value, Currency.USD);

// Reads like the "Оплата на Кит" template the managers fill in; the code is copyable. Numbers
// already in the system are marked: they only get the payment.
function kitLines(plan: KitPlan, existing: string[]): string[] {
  return [
    '💵 <b>Оплата на Кит</b>',
    `Код доступу: <code>${escapeHtml(plan.accessCode)}</code>`,
    `Загальна сума: <b>${usd(plan.total)}</b>`,
    'Замовлення та сума в доларах:',
    ...plan.items.map(
      (item) =>
        `№ <b>${escapeHtml(item.number)}</b> — ${usd(item.amount)}${existing.includes(item.number) ? ' (уже є в системі)' : ''}`,
    ),
    `Дата та час: ${plan.paidAt ? formatKyivDateTime(plan.paidAt) : '—'}`,
    ...(plan.comment ? [`Коментар: ${escapeHtml(plan.comment)}`] : []),
  ];
}

export function kitHint(): BotReply {
  const example = [
    'Код доступу: 647143353',
    'Загальна сума: 3500 дол',
    'Замовлення та сума в доларах:',
    '0000-062265 2 696,71 дол',
    '0000-062937 480,00 дол',
    '0000-065651 323,29 дол',
    'Дата та час: 21.08.2026 14:44',
  ].join('\n');
  return {
    html: [
      '💵 <b>Оплата на Кит</b>',
      'Надішліть одним повідомленням. Кожен номер із сумою в доларах з нового рядка:',
      '',
      `<pre>${escapeHtml(example)}</pre>`,
      '',
      `Файли (до ${MAX_FILES_PER_UPLOAD}) додавайте разом із текстом або перед ним.`,
    ].join('\n'),
  };
}

export function kitPreview(plan: KitPlan, existing: string[], files: number): BotReply {
  const lines = [
    '<b>Зрозумів так:</b>',
    '',
    ...kitLines(plan, existing),
    '',
    existing.length > 0
      ? 'Нові номери створю, а оплату запишу на кожен номер.'
      : 'Створю ці номери й одразу запишу на них оплату.',
    ...(files > 0 ? ['', `Файлів: ${files}`] : []),
    ...(plan.warnings.length > 0 ? ['', ...plan.warnings.map((w) => `⚠️ ${escapeHtml(w)}`)] : []),
  ];
  return {
    html: lines.join('\n'),
    buttons: [[button('✅ Надіслати', KitAction.Send), button('✏️ Виправити', KitAction.Edit)]],
  };
}

export function kitCreatedReply(plan: KitPlan): BotReply {
  return {
    html: [
      `💵 Оплату на Кит записано · ${usd(plan.total)}`,
      `Код доступу: <code>${escapeHtml(plan.accessCode)}</code>`,
    ].join('\n'),
  };
}

export function adminKitMessage(
  plan: KitPlan,
  existing: string[],
  managerName: string,
  now = new Date(),
): string {
  return [
    ...kitLines(plan, existing),
    '',
    `Менеджер: ${escapeHtml(managerName)}`,
    `Створено: ${formatKyivDateTime(now)}`,
  ].join('\n');
}
