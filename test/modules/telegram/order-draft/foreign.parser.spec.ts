import { parseForeign } from '../../../../src/modules/telegram/order-draft/foreign.parser';

// The manager's template, exactly as sent, with the fields filled in.
const TEMPLATE = `🌍 Оплата закордонного замовлення
На кого : Абертайм ТОВ ( EUR)
№  0000-066498
💰 Сума: 100 EUR
💱 Валюта: EUR
Дата : 13.10.2026 15:20
Курс : 44,9
Коментар: інвойс 17`;

const errorsOf = (text: string): string[] => {
  const result = parseForeign(text);
  if (result.ok) throw new Error('expected errors');
  return result.errors;
};

describe('parseForeign', () => {
  it('reads the filled template, emoji and spaces before the colon included', () => {
    const result = parseForeign(TEMPLATE);
    if (!result.ok) throw new Error(result.errors.join('; '));
    const { plan } = result;
    expect(plan.number).toBe('0000-066498');
    expect(plan.amount.toFixed(2)).toBe('100.00');
    expect(plan.recipient).toBe('Абертайм ТОВ ( EUR)');
    expect(plan.rate).toBe('44.9');
    expect(plan.paidAt?.toISOString()).toBe('2026-10-13T12:20:00.000Z');
    expect(plan.comment).toBe('інвойс 17');
    expect(plan.warnings).toEqual([]);
  });

  it('accepts the optional fields left empty, with a warning for «На кого»', () => {
    const result = parseForeign(`№ 0000-066498
Сума: 1 250,50 €
Дата: 13.10.2026 15:20
Курс :
Коментар:`);
    if (!result.ok) throw new Error(result.errors.join('; '));
    expect(result.plan.amount.toFixed(2)).toBe('1250.50');
    expect(result.plan.rate).toBeNull();
    expect(result.plan.comment).toBeNull();
    expect(result.plan.warnings).toEqual(['Не вказано, на кого.']);
  });

  it('asks for the number, the amount and the date with a time', () => {
    const errors = errorsOf('На кого: Абертайм ТОВ\nКурс: 44,9');

    expect(errors).toEqual([
      expect.stringContaining('Не знайшов номер замовлення'),
      expect.stringContaining('Не знайшов суму'),
      expect.stringContaining('Не вказано дату й час'),
    ]);
    expect(errorsOf(TEMPLATE.replace('15:20', ''))).toEqual([
      expect.stringContaining('Не вказано дату й час'),
    ]);
  });

  it('refuses a number that is not in the 1C format', () => {
    expect(errorsOf(TEMPLATE.replace('0000-066498', 'номер замовлення'))).toEqual([
      expect.stringContaining('Номер має бути у форматі'),
    ]);
  });

  it.each(['100 грн', '100 $', '100 дол'])('refuses the amount %p, euros only', (amount) => {
    expect(errorsOf(TEMPLATE.replace('100 EUR', amount))).toEqual(['Сума має бути в EUR.']);
  });

  it('refuses another currency in «Валюта» and a zero amount', () => {
    expect(errorsOf(TEMPLATE.replace('Валюта: EUR', 'Валюта: USD'))).toEqual(['Валюта лише EUR.']);
    expect(errorsOf(TEMPLATE.replace('100 EUR', '0 EUR'))).toEqual([
      'Сума має бути більшою за нуль.',
    ]);
  });

  it('keeps an unreadable rate as a warning, not an error', () => {
    const result = parseForeign(TEMPLATE.replace('44,9', 'вигідний'));
    expect(result.ok && result.plan.warnings).toEqual(['Не розібрав курс «вигідний».']);
  });
});
