import { cashPaymentId, parseCash } from '../../../../src/modules/telegram/order-draft/cash.parser';

// The manager's sample, exactly as written.
const SAMPLE = `0000-066498
01.09.2026 15:20
4260 грн
44,9
Христина Павлів передала готівку Христині Вихопень ( Саджениці)`;

const LABELED = `Оплата готівкою
Замовлення : 0000-066498
Дата : 01.09.2026 15:20
Сума : 150 $
Курс : 41,5
Ким передано : Христина Павлів`;

describe('parseCash', () => {
  it('reads the sample without labels, in hryvnias', () => {
    const result = parseCash(SAMPLE);
    if (!result.ok) throw new Error(result.errors.join('; '));
    const { plan } = result;
    expect(plan.number).toBe('0000-066498');
    expect(plan.paidAt?.toISOString()).toBe('2026-09-01T12:20:00.000Z');
    expect(plan.amount.toFixed(2)).toBe('4260.00');
    expect(plan.currency).toBe('UAH');
    expect(plan.rate).toBe('44.9');
    expect(plan.handedBy).toBe('Христина Павлів передала готівку Христині Вихопень ( Саджениці)');
    expect(plan.warnings).toEqual([]);
    expect(cashPaymentId(plan)).toBe('cash:0000-066498:2026-09-01T12:20:00.000Z:4260.00');
  });

  it('reads the labelled template, in dollars', () => {
    const result = parseCash(LABELED);
    if (!result.ok) throw new Error(result.errors.join('; '));
    expect(result.plan).toMatchObject({
      number: '0000-066498',
      currency: 'USD',
      rate: '41.5',
      handedBy: 'Христина Павлів',
    });
    expect(result.plan.amount.toFixed(2)).toBe('150.00');
  });

  it.each(['$150', '150 дол', '150 usd'])('takes %s for dollars', (amount) => {
    const result = parseCash(`0000-066498\n${amount}`);
    expect(result.ok && result.plan.currency).toBe('USD');
  });

  it('treats an amount with no unit as hryvnias and warns about missing fields', () => {
    const result = parseCash('0000-066498\n4260');
    expect(result.ok && result.plan.currency).toBe('UAH');
    expect(result.ok && result.plan.warnings).toEqual([
      'Не вказано дату.',
      'Не вказано, ким передано.',
    ]);
  });

  it('refuses without a number or an amount', () => {
    expect(parseCash('01.09.2026\n4260 грн')).toEqual({
      ok: false,
      errors: ['Не знайшов номер замовлення. Формат: 0000-066498.'],
    });
    expect(parseCash('0000-066498\nХристина')).toEqual({
      ok: false,
      errors: ['Не знайшов суму. Наприклад: 4260 грн.'],
    });
    expect(parseCash('000-066498\n4260 грн').ok).toBe(false);
  });
});
