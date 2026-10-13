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
    expect(plan.currency).toBe('EUR');
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
      expect.stringContaining('Не вказано валюту'),
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

  it.each([
    ['100 грн', 'UAH'],
    ['100 $', 'USD'],
    ['$100', 'USD'],
    ['100 дол', 'USD'],
    ['100 євро', 'EUR'],
  ])('reads the amount %p as %s', (amount, currency) => {
    const result = parseForeign(
      TEMPLATE.replace('100 EUR', amount).replace('💱 Валюта: EUR\n', ''),
    );
    expect(result.ok && result.plan.currency).toBe(currency);
  });

  it('takes the currency from «Валюта» alone, and refuses a clash or an unknown one', () => {
    const noUnit = TEMPLATE.replace('100 EUR', '100');
    expect(parseForeign(noUnit.replace('Валюта: EUR', 'Валюта: USD'))).toMatchObject({
      plan: { currency: 'USD' },
    });
    expect(errorsOf(TEMPLATE.replace('Валюта: EUR', 'Валюта: USD'))).toEqual([
      'У «Сума» і «Валюта» різні валюти.',
    ]);
    expect(errorsOf(TEMPLATE.replace('Валюта: EUR', 'Валюта: GBP'))).toEqual([
      expect.stringContaining('Не розібрав валюту «GBP»'),
    ]);
  });

  it('asks for the currency when neither «Сума» nor «Валюта» names it', () => {
    const text = TEMPLATE.replace('100 EUR', '100').replace('💱 Валюта: EUR\n', '');
    expect(errorsOf(text)).toEqual([expect.stringContaining('Не вказано валюту')]);
  });

  it('refuses a zero amount', () => {
    expect(errorsOf(TEMPLATE.replace('100 EUR', '0 EUR'))).toEqual([
      'Сума має бути більшою за нуль.',
    ]);
  });

  it('keeps an unreadable rate as a warning, not an error', () => {
    const result = parseForeign(TEMPLATE.replace('44,9', 'вигідний'));
    expect(result.ok && result.plan.warnings).toEqual(['Не розібрав курс «вигідний».']);
  });
});
