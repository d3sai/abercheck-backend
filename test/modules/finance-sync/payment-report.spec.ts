import { kyivDateTime } from '../../../src/common/kyiv-time';
import { Prisma } from '../../../src/generated/prisma/client';
import {
  paymentProgressLine,
  paymentReportMessage,
  UNNAMED_PAYER,
} from '../../../src/modules/finance-sync/payment-report';

const d = (value: string) => new Prisma.Decimal(value);

describe('paymentProgressLine', () => {
  it('should show what is left while the sum is not reached', () => {
    expect(paymentProgressLine(d('50000'), d('200000'))).toBe(
      '💰 Оплачено 50 000 грн з 200 000 грн · залишок 150 000 грн',
    );
  });

  it('should say fully paid on the exact sum', () => {
    expect(paymentProgressLine(d('200000'), d('200000'))).toBe('✅ Оплачено повністю: 200 000 грн');
  });

  it('should show the overpayment', () => {
    expect(paymentProgressLine(d('205000'), d('200000'))).toBe(
      '✅ Оплачено 205 000 грн з 200 000 грн · переплата 5 000 грн',
    );
  });
});

describe('paymentReportMessage', () => {
  const base = {
    orderNumbers: ['0000-070217'],
    clientName: 'ФОП Іванов',
    managerName: 'Уляна',
    due: d('200000'),
  };

  it('should mark a payment smaller than the total as a part', () => {
    const html = paymentReportMessage({
      ...base,
      added: [
        {
          payerName: UNNAMED_PAYER,
          amount: d('50000'),
          paidAt: kyivDateTime(2026, 11, 18, 14, 30),
        },
      ],
      paid: d('50000'),
    });

    expect(html.split('\n')).toEqual([
      '💳 <b>Оплата</b> · № 0000-070217',
      '<b>ФОП Іванов</b>',
      '• 50 000 грн · 14:30 18.11.2026 · частина',
      '💰 Оплачено 50 000 грн з 200 000 грн · залишок 150 000 грн',
      '',
      'Менеджер: Уляна',
    ]);
  });

  it('should show a named payer first and leave a full payment unmarked', () => {
    const html = paymentReportMessage({
      ...base,
      orderNumbers: ['0000-070217', '0000-070218'],
      added: [
        { payerName: 'Іван <Петрович>', amount: d('30000'), paidAt: kyivDateTime(2026, 11, 19) },
        { payerName: UNNAMED_PAYER, amount: d('200000'), paidAt: kyivDateTime(2026, 11, 19) },
      ],
      paid: d('230000'),
    });

    expect(html).toContain('💳 <b>Оплата</b> · № 0000-070217, 0000-070218');
    expect(html).toContain('• Іван &lt;Петрович&gt; · 30 000 грн · 19.11.2026 · частина');
    expect(html).toContain('• 200 000 грн · 19.11.2026\n');
    expect(html).not.toContain(UNNAMED_PAYER);
  });
});
