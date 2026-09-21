import { type Order, OrderType, Prisma } from '../../../generated/prisma/client';
import { MAX_FILES_PER_UPLOAD } from '../../attachments/attachments.constants';
import { type BotReply, button } from '../core/bot-reply';
import { escapeHtml, formatMoney } from '../core/format';
import type { RequisitesPlan } from './requisites.parser';

export const RequisitesAction = {
  Send: 'req:ok',
  Edit: 'req:edit',
  Regular: 'req:regular',
} as const;

const money = (value: Prisma.Decimal): string => `${formatMoney(value)} грн`;

export function requisitesHint(): BotReply {
  // The same order as the regular template: number, recipients (where the FOP goes), rate, comment.
  const example = [
    '0000-066092',
    'ФОП Носенко Роман - 4 527,00 грн 14:57',
    '4441 1110 6964 5962 Андріанов Олександр - 2 140,00 грн 14:59',
    '45',
    'Коментар: 07.09.2026',
  ].join('\n');
  return {
    html: [
      '💳 <b>Оплата на інші реквізити</b>',
      'Надішліть одним повідомленням, у довільному вигляді: номер(и) замовлення, суми, усі реквізити (картки, ФОП, IBAN — скільки завгодно), курс і коментар.',
      '• Суми пишіть зі словом «грн».',
      '• Кілька номерів однією оплатою — кожен з нового рядка разом із сумою.',
      '• Немає номера — це буде закриття мінусу.',
      '• Окрема дата піде в коментар. Свій коментар пишіть рядком «Коментар: …».',
      '• Не вказали загальну суму? Я порахую її сам, а ви перевірите. Можна дописати рядок «Загальна сума: 9 067 грн».',
      `Файли (до ${MAX_FILES_PER_UPLOAD}) — разом із повідомленням або перед ним.`,
      '',
      'Наприклад:',
      `<pre>${example}</pre>`,
    ].join('\n'),
  };
}

export function requisitesErrors(errors: string[]): BotReply {
  return {
    html: [
      '⚠️ Не вдалося прийняти повідомлення:',
      ...errors.map((error) => `• ${escapeHtml(error)}`),
      '',
      'Виправте та надішліть ще раз.',
    ].join('\n'),
  };
}

export interface PreviewContext {
  /** The single number already exists: this becomes one more part of it. */
  addsPart: boolean;
  /** Numbers left out of a group because they already exist. */
  skipped: string[];
  files: number;
  /** The bot recognised the message on its own; the manager did not press the button. */
  auto: boolean;
}

function breakdown(plan: RequisitesPlan): string | null {
  return plan.amountLines.length > 1
    ? plan.amountLines.map((amount) => formatMoney(amount)).join(' + ')
    : null;
}

const withNote = (text: string, note: string | null): string =>
  note ? `${text} ${escapeHtml(note)}` : text;

// The sections come in the order of the regular order template: number, recipients (where the FOP
// goes), amount, rate, comment.
export function requisitesPreview(plan: RequisitesPlan, context: PreviewContext): BotReply {
  const lines: string[] = [];
  const parts = breakdown(plan);

  lines.push(
    plan.kind === 'group'
      ? '<b>Зрозумів так</b> — кілька номерів однією оплатою:'
      : plan.kind === 'minus'
        ? '<b>Зрозумів так</b> — закриття мінусу, номера немає:'
        : '<b>Зрозумів так</b>:',
  );
  if (context.auto) {
    lines.push('Схоже на оплату на інші реквізити — розібрав як таку.');
  }

  if (plan.kind === 'group') {
    for (const item of plan.items) {
      lines.push(
        withNote(`№ <b>${escapeHtml(item.number)}</b> — ${money(item.amount)}`, item.note),
      );
    }
  } else if (plan.kind === 'single') {
    lines.push(withNote(`№ <b>${escapeHtml(plan.items[0]!.number)}</b>`, plan.items[0]!.note));
  }
  if (plan.requisites) {
    lines.push('Реквізити:', `<pre>${escapeHtml(plan.requisites)}</pre>`);
  }
  lines.push(
    plan.kind === 'group'
      ? `Разом: <b>${money(plan.total)}</b>`
      : `Сума: <b>${money(plan.total)}</b>${parts ? ` (${parts})` : ''}`,
  );
  if (plan.rate) {
    lines.push(`Курс: ${escapeHtml(plan.rate.replace('.', ','))}`);
  }
  if (plan.comment) {
    lines.push(`Коментар: ${escapeHtml(plan.comment)}`);
  }
  lines.push(`Підпис у списках: ${escapeHtml(plan.label)}`);
  if (context.files > 0) {
    lines.push(`Файлів: ${context.files}`);
  }

  const warnings = [
    ...(context.addsPart
      ? ['Такий номер уже є в системі — це буде ще однією частиною цього номера.']
      : []),
    ...(context.skipped.length > 0
      ? [`Не додаю, бо вони вже є в системі: ${context.skipped.join(', ')}.`]
      : []),
    ...plan.warnings,
  ];
  if (warnings.length > 0) {
    lines.push('', ...warnings.map((warning) => `⚠️ ${escapeHtml(warning)}`));
  }

  return {
    html: lines.join('\n'),
    buttons: [
      [
        button('✅ Надіслати', RequisitesAction.Send),
        button('✏️ Виправити', RequisitesAction.Edit),
      ],
      ...(context.auto ? [[button('📝 Це звичайне замовлення', RequisitesAction.Regular)]] : []),
    ],
  };
}

export function requisitesCreatedReply(orders: Order[], skipped: string[]): BotReply {
  const [first] = orders;
  const total = orders.reduce((sum, order) => sum.plus(order.amountDue), new Prisma.Decimal(0));
  const skippedNote =
    skipped.length > 0 ? [`Не додано (уже є в системі): ${skipped.join(', ')}.`] : [];

  if (!first) {
    return { html: '⚠️ Нічого не створено.' };
  }
  if (first.orderType === OrderType.MINUS_CLOSING) {
    return {
      html: [
        `➖ Закриття мінусу створено · ${money(total)}`,
        escapeHtml(first.clientName),
        ...skippedNote,
      ].join('\n'),
    };
  }
  const head =
    orders.length > 1
      ? `✅ Оплату на інші реквізити зареєстровано: ${orders.length} номерів · ${money(total)}`
      : `✅ Оплату на інші реквізити зареєстровано: № <b>${escapeHtml(first.orderNumber)}</b> · ${money(total)}`;
  return {
    html: [head, 'Повідомлю про оплату.', ...skippedNote].join('\n'),
  };
}
