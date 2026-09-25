import { OrderStatus, Prisma } from '../../../../src/generated/prisma/client';
import type {
  OrderWithManager,
  OrderWithPaid,
} from '../../../../src/modules/orders/orders.service';
import type { DailyReport } from '../../../../src/modules/reports/daily-report.service';
import {
  dailyReportMessage,
  underpaidMessage,
} from '../../../../src/modules/telegram/reports/report.messages';

const d = (value: string) => new Prisma.Decimal(value);

const report = (overrides: Partial<DailyReport> = {}): DailyReport => ({
  dayStart: new Date('2026-09-02T21:00:00Z'),
  paymentsCount: 47,
  totalAmount: d('486350'),
  byBucket: {
    AWAITING_PAYMENT: 0,
    PAID: 39,
    PARTIALLY_PAID: 4,
    OVERPAID: 1,
    UNDERPAID: 2,
    CANCELLED: 0,
    UNMATCHED: 1,
  },
  refundsCount: 0,
  refundsAmount: d('0'),
  usd: { paymentsAmount: d('0'), refundsCount: 0, refundsAmount: d('0') },
  ...overrides,
});

const underpaidOrder = {
  order: {
    orderNumber: '0000-066717',
    baseNumber: '0000-066717',
    clientName: 'Петренко',
    amountDue: d('6158.41'),
    status: OrderStatus.UNDERPAID,
    manager: { name: 'Христина' },
  },
  amountPaid: d('6157'),
} as OrderWithPaid<OrderWithManager>;

describe('dailyReportMessage', () => {
  it('should follow the template from the original TZ', () => {
    expect(dailyReportMessage(report())).toBe(
      [
        '📊 <b>Звіт за 03.09.2026</b>',
        'Кількість платежів: 47',
        '🟢 Повністю звірено: 39',
        '🔵 Часткова оплата: 4',
        '🟠 Переплата: 1',
        '🔴 Недоплата: 2',
        '⚠️ Потрібна перевірка: 1',
        '💰 Загальна сума надходжень: 486 350 грн',
      ].join('\n'),
    );
  });

  it('should add cancellations, refunds and newly underpaid orders only when present', () => {
    const message = dailyReportMessage(
      report({
        byBucket: { ...report().byBucket, CANCELLED: 1 },
        refundsCount: 2,
        refundsAmount: d('51.41'),
      }),
      [underpaidOrder],
    );

    expect(message).toContain('❌ Скасовані замовлення: 1');
    expect(message).toContain('↩️ Повернення: 2 на 51,41 грн');
    expect(message).toContain(
      '<b>🔴 Без доплати до кінця дня (1)</b>\n0000-066717 · Петренко · залишок 1,41 грн · Христина',
    );
  });
});

describe('underpaidMessage', () => {
  it('should show what is still owed', () => {
    expect(underpaidMessage(underpaidOrder)).toContain('Сплачено: 6 157 грн\nЗалишок: 1,41 грн');
  });

  it('should show dollars on their own lines, and only when there are any', () => {
    expect(dailyReportMessage(report())).not.toContain('$');

    const message = dailyReportMessage(
      report({
        usd: { paymentsAmount: d('200.5'), refundsCount: 1, refundsAmount: d('5') },
      }),
    );

    expect(message).toContain('💰 Загальна сума надходжень: 486 350 грн');
    expect(message).toContain('💵 Надходження в доларах: 200,50 $');
    expect(message).toContain('↩️ Повернення в доларах: 1 на 5 $');
  });
});
