import {
  parseExchangeRate,
  parseFreeform,
  parseMoney,
  parseOrderNumber,
  parseTemplate,
  parseText,
} from '../../../../src/modules/telegram/order-draft/order-draft.parsers';

const value = (result: ReturnType<typeof parseMoney>) => (result.ok ? result.value : null);

describe('order draft parsers', () => {
  it.each([
    ['0000-066717', '0000-066717'],
    ['№А 0000-066717', '0000-066717'],
    ['1548', null],
    ['0000-06671', null],
  ])('parseOrderNumber(%p) → %p', (input, expected) => {
    expect(value(parseOrderNumber(input))).toBe(expected);
  });

  it('should point out a number that is one digit short instead of fixing it', () => {
    expect(parseOrderNumber('000-066717')).toEqual({
      ok: false,
      error: 'Бракує цифри. Може, 0000-066717?',
    });
  });

  it.each([
    ['6 158,41 грн', '6158.41'],
    ['6158.41', '6158.41'],
    ['17675', '17675'],
    ['1 197,2', '1197.2'],
    ['4\u00a0594.45 грн.', '4594.45'],
    ['17 933,31 ГРН', '17933.31'],
    ['6.158,41', null],
    ['0', null],
    ['-100', null],
    ['12,345', null],
    ['сто', null],
  ])('parseMoney(%p) → %p', (input, expected) => {
    expect(value(parseMoney(input))).toBe(expected);
  });

  it.each([
    ['44,9', '44.9'],
    ['44,9%', '44.9'],
    ['44.95 %', '44.95'],
    ['0', null],
    ['44,12345', null],
  ])('parseExchangeRate(%p) → %p', (input, expected) => {
    expect(value(parseExchangeRate(input))).toBe(expected);
  });

  it('should trim text and enforce the length limit', () => {
    const parse = parseText(5);

    expect(value(parse('  abc  '))).toBe('abc');
    expect(value(parse('   '))).toBeNull();
    expect(value(parse('abcdef'))).toBeNull();
  });

  describe('parseTemplate', () => {
    const fields = [
      { field: 'orderNumber', label: 'Номер' },
      { field: 'clientName', label: 'ФОП' },
      { field: 'comment', label: 'Коментар' },
    ];

    it('should map each labelled line to its field', () => {
      const text = ['Номер: 0000-066717', 'ФОП: Чернявський Владислав', 'Коментар: '].join('\n');

      expect(parseTemplate(text, fields)).toEqual({
        orderNumber: '0000-066717',
        clientName: 'Чернявський Владислав',
        comment: '',
      });
    });

    it('should capture a multi-line value up to the next label', () => {
      const text = ['Номер: 0000-066717', 'Коментар: рядок один', 'рядок два', 'ФОП: Іванов'].join(
        '\n',
      );

      expect(parseTemplate(text, fields)).toEqual({
        orderNumber: '0000-066717',
        comment: 'рядок один\nрядок два',
        clientName: 'Іванов',
      });
    });

    it('should ignore text before the first label and be case-insensitive', () => {
      const text = ['щось стороннє', 'номер: 0000-066717'].join('\n');

      expect(parseTemplate(text, fields)).toEqual({ orderNumber: '0000-066717' });
    });

    it('should return an empty map when no label matches', () => {
      expect(parseTemplate('просто текст', fields)).toEqual({});
    });
  });

  describe('parseFreeform', () => {
    it('should read number, name, amount, rate and comment by shape, one per line', () => {
      const text = ['1234-567890', 'Тест Тест Тест', '1000 грн', '48', 'коментар'].join('\n');

      expect(parseFreeform(text)).toEqual({
        orderNumber: '1234-567890',
        clientName: 'Тест Тест Тест',
        amountDue: '1000 грн',
        exchangeRate: '48',
        comment: 'коментар',
      });
    });

    it('should treat a missing order number as a minus-closing order', () => {
      const text = ['Тест Тест Тест', '1000 грн', '48', 'коментар'].join('\n');

      expect(parseFreeform(text)).toEqual(
        expect.objectContaining({ clientName: 'Тест Тест Тест', amountDue: '1000 грн' }),
      );
      expect(parseFreeform(text)).not.toHaveProperty('orderNumber');
    });

    it('should work with only the required lines', () => {
      const text = ['Тест Тест Тест', '1000 грн'].join('\n');

      expect(parseFreeform(text)).toEqual({ clientName: 'Тест Тест Тест', amountDue: '1000 грн' });
    });

    it('should treat a non-numeric line after the amount as the start of the comment', () => {
      const text = ['Тест Тест Тест', '1000 грн', 'Терміново, дзвонити з ранку'].join('\n');

      expect(parseFreeform(text)).toEqual({
        clientName: 'Тест Тест Тест',
        amountDue: '1000 грн',
        comment: 'Терміново, дзвонити з ранку',
      });
    });

    it('should join a multi-line name and a multi-line comment', () => {
      const text = ['ТОВ', 'Ромашка', '1000 грн', 'рядок один', 'рядок два'].join('\n');

      expect(parseFreeform(text)).toEqual({
        clientName: 'ТОВ Ромашка',
        amountDue: '1000 грн',
        comment: 'рядок один\nрядок два',
      });
    });

    it('should return null when nothing reads as an amount', () => {
      expect(parseFreeform(['1234-567890', 'Тест Тест Тест'].join('\n'))).toBeNull();
      expect(parseFreeform('просто повідомлення без сум')).toBeNull();
    });
  });
});
