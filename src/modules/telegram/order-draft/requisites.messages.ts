import {
  type Order,
  OrderType,
  type OrderRequisite,
  Prisma,
} from '../../../generated/prisma/client';
import { MAX_FILES_PER_UPLOAD } from '../../attachments/attachments.constants';
import { type BotReply, button } from '../core/bot-reply';
import { escapeHtml, formatKyivDateTime, formatMoneyGrn as money } from '../core/format';
import { MENU_LABEL } from '../core/menu';
import type { RequisitesPlan } from './requisites.parser';

export const RequisitesAction = {
  Send: 'req:ok',
  Edit: 'req:edit',
  Regular: 'req:regular',
} as const;

// One requisite, one copyable block: every field on its own line inside <pre>, so tapping it copies
// exactly the payer/account/amount/date — nothing else — instead of a whole run-on line.
function requisiteBlock(
  payerName: string,
  account: string | null,
  amount: Prisma.Decimal,
  paidAt: Date,
): string {
  const fields = [
    payerName,
    ...(account ? [account] : []),
    money(amount),
    formatKyivDateTime(paidAt),
  ];
  return `<pre>${fields.map(escapeHtml).join('\n')}</pre>`;
}

export function requisitesHint(): BotReply {
  const example = [
    '0000-066092',
    '07.09.2026',
    'ФОП Носенко Роман - 4 527,00 грн 14:57',
    '4441 1110 6964 5962 Андріанов Олександр - 2 140,00 грн 14:59',
    '45',
  ].join('\n');
  return {
    html: [
      '💳 <b>Кілька номерів або реквізити — одним повідомленням</b>',
      'Пишіть у будь-якому порядку: номер(и), суми, реквізити (картки, ФОП, IBAN), курс, дату чи коментар.',
      '• Кілька номерів однією оплатою — кожен з нового рядка разом із сумою.',
      '• Немає номера — це закриття мінусу.',
      '• Не порахували загальну суму — порахую сам, а ви перевірте.',
      `Файли (до ${MAX_FILES_PER_UPLOAD}) — разом із повідомленням або перед ним.`,
      '',
      'Наприклад:',
      `<pre>${example}</pre>`,
    ].join('\n'),
  };
}

// The regular single-order template never guesses at this — it refuses and points at the button, so
// a message with several numbers or someone else's requisites is never silently misread.
export function multipleOrRequisitesGuard(): BotReply {
  return {
    html: [
      '⚠️ Це схоже на кілька номерів або оплату на чужі реквізити.',
      `Спочатку натисніть кнопку «${escapeHtml(MENU_LABEL.Requisites)}» (або команду /requisites), а тоді надішліть це саме повідомлення ще раз.`,
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
}

export function requisitesPreview(plan: RequisitesPlan, context: PreviewContext): BotReply {
  const lines: string[] = [
    plan.kind === 'group'
      ? '<b>Зрозумів так</b> — кілька номерів однією оплатою:'
      : plan.kind === 'minus'
        ? '<b>Зрозумів так</b> — закриття мінусу, номера немає:'
        : '<b>Зрозумів так</b>:',
  ];

  if (plan.kind === 'group') {
    for (const item of plan.items) {
      const note = item.note ? ` ${escapeHtml(item.note)}` : '';
      lines.push(`№ <b>${escapeHtml(item.number)}</b> — ${money(item.amount)}${note}`);
    }
    lines.push(`Разом: <b>${money(plan.total)}</b>`);
  } else {
    if (plan.kind === 'single') {
      lines.push(`№ <b>${escapeHtml(plan.items[0]!.number)}</b>`);
    }
    lines.push(`Сума: <b>${money(plan.total)}</b>`);
  }
  if (plan.rate) {
    lines.push(`Курс: ${escapeHtml(plan.rate.replace('.', ','))}`);
  }
  if (plan.comment) {
    lines.push(`Коментар: ${escapeHtml(plan.comment)}`);
  }
  if (plan.requisiteLines.length > 0) {
    lines.push('', 'Реквізити:');
    plan.requisiteLines.forEach((item, index) => {
      if (index > 0) {
        lines.push('');
      }
      lines.push(
        requisiteBlock(item.payerName, item.account, new Prisma.Decimal(item.amount), item.paidAt),
      );
    });
  }
  lines.push('', `Підпис у списках: ${escapeHtml(plan.label)}`);
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
      [button('📝 Це звичайне замовлення', RequisitesAction.Regular)],
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
      ? `✅ Оплату зареєстровано: ${orders.length} номерів · ${money(total)}`
      : `✅ Оплату зареєстровано: № <b>${escapeHtml(first.orderNumber)}</b> · ${money(total)}`;
  return {
    html: [head, 'Повідомлю про оплату.', ...skippedNote].join('\n'),
  };
}

// One notice for the whole payment: numbers/amount, rate, comment, then every requisite that was
// read out of the message, then who and when — same layout as a regular order notice.
export function adminRequisitesMessage(
  orders: Order[],
  managerName: string,
  requisites: OrderRequisite[],
  skipped: string[] = [],
): string {
  const [first] = orders;
  if (!first) {
    return '';
  }
  const total = orders.reduce((sum, order) => sum.plus(order.amountDue), new Prisma.Decimal(0));
  const isMinus = first.orderType === OrderType.MINUS_CLOSING;
  const title = isMinus
    ? '➖ <b>Закриття мінусу</b>'
    : first.orderNumber === first.baseNumber
      ? '💳 <b>Оплата на реквізити</b>'
      : '➕ <b>Оплата на реквізити · нова частина</b>';
  const numbers =
    orders.length > 1
      ? orders.map(
          (order) => `№ <b>${escapeHtml(order.orderNumber)}</b> — ${money(order.amountDue)}`,
        )
      : isMinus
        ? []
        : [`№ <b>${escapeHtml(first.orderNumber)}</b>`];
  return [
    title,
    ...numbers,
    orders.length > 1 ? `Разом: ${money(total)}` : `Сума: ${money(total)}`,
    ...(first.exchangeRate
      ? [
          `Курс: ${first.exchangeRate.toFixed(4).replace(/0+$/, '').replace(/\.$/, '').replace('.', ',')}`,
        ]
      : []),
    ...(first.comment ? [`Коментар: ${escapeHtml(first.comment)}`] : []),
    ...(requisites.length > 0
      ? [
          '',
          'Реквізити:',
          ...requisites.flatMap((item, index) => [
            ...(index > 0 ? [''] : []),
            requisiteBlock(item.payerName, item.account, item.amount, item.paidAt),
          ]),
        ]
      : []),
    ...(skipped.length > 0 ? [`Не додано (уже є в системі): ${skipped.join(', ')}`] : []),
    '',
    `Менеджер: ${escapeHtml(managerName)}`,
    `Створено: ${formatKyivDateTime(first.createdAt)}`,
  ].join('\n');
}
