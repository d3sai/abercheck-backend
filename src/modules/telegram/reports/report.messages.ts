import type { OrderWithManager, OrderWithPaid } from '../../orders/orders.service';
import type { DailyReport } from '../../reports/daily-report.service';
import { escapeHtml, formatKyivDate, formatMoney } from '../core/format';

export function dailyReportMessage(
  report: DailyReport,
  underpaid: OrderWithPaid<OrderWithManager>[] = [],
  title = 'Звіт за',
): string {
  const { byBucket } = report;
  const lines = [
    `📊 <b>${title} ${formatKyivDate(report.dayStart)}</b>`,
    `Кількість платежів: ${report.paymentsCount}`,
    `🟢 Повністю звірено: ${byBucket.PAID}`,
    `🔵 Часткова оплата: ${byBucket.PARTIALLY_PAID}`,
    `🟠 Переплата: ${byBucket.OVERPAID}`,
    `🔴 Недоплата: ${byBucket.UNDERPAID}`,
    `⚠️ Потрібна перевірка: ${byBucket.UNMATCHED}`,
    ...(byBucket.CANCELLED > 0 ? [`❌ Скасовані замовлення: ${byBucket.CANCELLED}`] : []),
    `💰 Загальна сума надходжень: ${formatMoney(report.totalAmount)} грн`,
    ...(report.refundsCount > 0
      ? [`↩️ Повернення: ${report.refundsCount} на ${formatMoney(report.refundsAmount)} грн`]
      : []),
  ];

  if (underpaid.length > 0) {
    lines.push(
      '',
      `<b>🔴 Без доплати до кінця дня (${underpaid.length})</b>`,
      ...underpaid.map(
        ({ order, amountPaid }) =>
          `${escapeHtml(order.orderNumber)} · ${escapeHtml(order.clientName)} · залишок ${formatMoney(order.amountDue.minus(amountPaid))} грн · ${escapeHtml(order.manager.name)}`,
      ),
    );
  }
  return lines.join('\n');
}

export function underpaidMessage({ order, amountPaid }: OrderWithPaid<OrderWithManager>): string {
  return [
    '🔴 <b>Недоплата</b>',
    `ФОП: <b>${escapeHtml(order.clientName)}</b>`,
    `Замовлення № ${escapeHtml(order.orderNumber)}`,
    `Сума замовлення: ${formatMoney(order.amountDue)} грн`,
    `Сплачено: ${formatMoney(amountPaid)} грн`,
    `Залишок: ${formatMoney(order.amountDue.minus(amountPaid))} грн`,
    'Доплата не надійшла до кінця дня — статус: НЕДОПЛАТА.',
  ].join('\n');
}
