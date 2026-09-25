import {
  type Currency,
  type Order,
  type OrderRequisite,
  Prisma,
} from '../../../generated/prisma/client';
import { MAX_FILES_PER_UPLOAD } from '../../attachments/attachments.constants';
import { type BotReply, button } from '../core/bot-reply';
import { escapeHtml, formatKyivDateTime, formatMoneyIn as money } from '../core/format';
import { MENU_LABEL } from '../core/menu';
import { formatRate } from '../notifications/order-templates';
import type { RequisitesPlan } from './requisites.parser';

export const RequisitesAction = {
  Send: 'req:ok',
  Edit: 'req:edit',
  Regular: 'req:regular',
} as const;

export function requisiteBlock(
  payerName: string,
  account: string | null,
  amount: Prisma.Decimal,
  currency: Currency,
  paidAt: Date,
): string {
  const fields = [
    payerName,
    ...(account ? [account] : []),
    money(amount, currency),
    formatKyivDateTime(paidAt),
  ];
  return `<pre>${fields.map(escapeHtml).join('\n')}</pre>`;
}

export function requisitesHint(): BotReply {
  const example = [
    '0000-066092',
    '07.09.2026',
    'ФОП Носенко Роман 4 527 грн 14:57',
    '4441 1110 6964 5962 Андріанов Олександр 2 140 грн 14:59',
    '45',
  ].join('\n');
  return {
    html: [
      '💳 <b>Кілька номерів або чужі реквізити</b>',
      'Усе одним повідомленням, порядок не важливий. Кожен номер з нового рядка разом із сумою.',
      'Суми в доларах пишіть зі знаком $ — усі суми в повідомленні в одній валюті.',
      '',
      `<pre>${example}</pre>`,
      '',
      `Файли (до ${MAX_FILES_PER_UPLOAD}) додавайте разом із текстом або перед ним.`,
    ].join('\n'),
  };
}

export function multipleOrRequisitesGuard(): BotReply {
  return {
    html: [
      '⚠️ Схоже на кілька номерів або чужі реквізити.',
      `Натисніть «${escapeHtml(MENU_LABEL.Requisites)}» (/requisites) і надішліть це повідомлення ще раз.`,
    ].join('\n'),
  };
}

export function requisitesErrors(errors: string[]): BotReply {
  return {
    html: [
      '⚠️ Не вийшло прочитати:',
      ...errors.map((error) => `• ${escapeHtml(error)}`),
      'Виправте й надішліть ще раз.',
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
      : '<b>Зрозумів так</b>:',
  ];

  if (plan.kind === 'group') {
    for (const item of plan.items) {
      const note = item.note ? ` ${escapeHtml(item.note)}` : '';
      lines.push(
        `№ <b>${escapeHtml(item.number)}</b> — ${money(item.amount, plan.currency)}${note}`,
      );
    }
    lines.push(`Разом: <b>${money(plan.total, plan.currency)}</b>`);
  } else {
    if (plan.kind === 'single') {
      lines.push(`№ <b>${escapeHtml(plan.items[0]!.number)}</b>`);
    }
    lines.push(`Сума: <b>${money(plan.total, plan.currency)}</b>`);
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
        requisiteBlock(
          item.payerName,
          item.account,
          new Prisma.Decimal(item.amount),
          plan.currency,
          item.paidAt,
        ),
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
  if (!first) {
    return { html: '⚠️ Нічого не створено.' };
  }
  const total = orders.reduce((sum, order) => sum.plus(order.amountDue), new Prisma.Decimal(0));
  const skippedNote =
    skipped.length > 0 ? [`Не додано (уже є в системі): ${skipped.join(', ')}.`] : [];

  const head =
    orders.length > 1
      ? `✅ Оплату зареєстровано: ${orders.length} номерів · ${money(total, first.currency)}`
      : `✅ Оплату зареєстровано: № <b>${escapeHtml(first.orderNumber)}</b> · ${money(total, first.currency)}`;
  return {
    html: [head, 'Повідомлю про оплату.', ...skippedNote].join('\n'),
  };
}

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
  const title =
    first.orderNumber === first.baseNumber
      ? '💳 <b>Оплата на реквізити</b>'
      : '➕ <b>Оплата на реквізити · нова частина</b>';
  const numbers =
    orders.length > 1
      ? orders.map(
          (order) =>
            `№ <b>${escapeHtml(order.orderNumber)}</b> — ${money(order.amountDue, order.currency)}`,
        )
      : [`№ <b>${escapeHtml(first.orderNumber)}</b>`];
  return [
    title,
    ...numbers,
    orders.length > 1
      ? `Разом: ${money(total, first.currency)}`
      : `Сума: ${money(total, first.currency)}`,
    ...(first.exchangeRate ? [`Курс: ${formatRate(first.exchangeRate)}`] : []),
    ...(first.comment ? [`Коментар: ${escapeHtml(first.comment)}`] : []),
    ...(requisites.length > 0
      ? [
          '',
          'Реквізити:',
          ...requisites.flatMap((item, index) => [
            ...(index > 0 ? [''] : []),
            requisiteBlock(item.payerName, item.account, item.amount, first.currency, item.paidAt),
          ]),
        ]
      : []),
    ...(skipped.length > 0 ? [`Не додано (уже є в системі): ${skipped.join(', ')}`] : []),
    '',
    `Менеджер: ${escapeHtml(managerName)}`,
    `Створено: ${formatKyivDateTime(first.createdAt)}`,
  ].join('\n');
}
