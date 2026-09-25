import { parseKit } from '../../../../src/modules/telegram/order-draft/kit.parser';

// The manager's example, exactly as written (typos included).
const EXAMPLE = `Оплата на Кит
Код доступу : 647143353
Загальна сума : 3500 дол сума переказу
Замовлення  та сума в доларах :
0000-062265 2 696,71 дол
0000-062937 480,00 дол
залишок 323,29 дол внести в це замволення 0000-065651
Дата та час : 21.08.2026 14:44`;

describe('parseKit', () => {
  it('reads the example: code, total, every number with its amount, date', () => {
    const result = parseKit(EXAMPLE);
    if (!result.ok) throw new Error(result.errors.join('; '));
    const { plan } = result;
    expect(plan.accessCode).toBe('647143353');
    expect(plan.total.toFixed(2)).toBe('3500.00');
    expect(plan.items.map((i) => [i.number, i.amount.toFixed(2)])).toEqual([
      ['0000-062265', '2696.71'],
      ['0000-062937', '480.00'],
      ['0000-065651', '323.29'],
    ]);
    expect(plan.paidAt?.toISOString()).toBe('2026-08-21T11:44:00.000Z');
    expect(plan.comment).toBeNull();
    expect(plan.warnings).toEqual([]);
  });

  it('warns when the numbers do not add up to the transfer', () => {
    const result = parseKit(EXAMPLE.replace('480,00', '400,00'));
    expect(result.ok && result.plan.warnings).toEqual([
      'Замовлення разом 3 420 $, а переказ 3 500 $ (різниця 80 $).',
    ]);
  });

  it('accepts $ and numbers without a unit', () => {
    const result = parseKit('Код доступу: 1\n0000-062265 $100\n0000-062937 50');
    expect(result.ok && result.plan.total.toFixed(2)).toBe('150.00');
  });

  it('refuses without an access code, a number, or with hryvnias', () => {
    expect(parseKit('Загальна сума: 100 дол\n0000-062265 100 дол')).toEqual({
      ok: false,
      errors: ['Не знайшов код доступу. Додайте рядок «Код доступу: 647143353».'],
    });
    expect(parseKit('Код доступу: 1\nСума: 100 дол').ok).toBe(false);
    expect(parseKit('Код доступу: 1\n0000-062265 100 грн').ok).toBe(false);
    expect(parseKit('Код доступу: 1\n0000-062265\n0000-062265 5 дол').ok).toBe(false);
  });
});
