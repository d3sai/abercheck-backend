import { unitAfterAmount } from '../../../../src/modules/telegram/order-draft/requisites.parser';

describe('unitAfterAmount', () => {
  it('should turn a leading "$" into a trailing unit, but leave a "$" glued to a word alone', () => {
    expect(unitAfterAmount('Сума: $1 500, курс 45')).toBe('Сума: 1 500 $, курс 45');
    expect(unitAfterAmount('url?x=$5')).toBe('url?x=$5');
    expect(unitAfterAmount('150 $')).toBe('150 $');
  });

  it('should not pull the next line or a time into a trailing "$"', () => {
    expect(unitAfterAmount('0000-068772 100 $\n0000-068773 50 $')).toBe(
      '0000-068772 100 $\n0000-068773 50 $',
    );
    expect(unitAfterAmount('ФОП Гук 590.50 $ 10:50')).toBe('ФОП Гук 590.50 $ 10:50');
  });
});
