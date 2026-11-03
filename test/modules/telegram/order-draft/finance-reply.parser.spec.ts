import { parseFinanceReply } from '../../../../src/modules/telegram/order-draft/finance-reply.parser';

const NOTICE = [
  '✅ Ваш запит на 6\u00a0274,68 грн · замовлення 0000-074404 прийнято',
  'Прийняв: Admin',
  'ФОП: ТОВ Абертайм',
].join('\n');

describe('parseFinanceReply', () => {
  it('should read number, sum and FOP from the finance notice', () => {
    expect(parseFinanceReply(NOTICE)).toEqual({
      fields: {
        orderNumber: '0000-074404',
        amountDue: '6\u00a0274,68 грн',
        clientName: 'ТОВ Абертайм',
      },
      requisites: false,
    });
  });

  it('should take the first rate-like line as the rate and the rest as the comment', () => {
    expect(parseFinanceReply(`${NOTICE}\n45,7\n03.11.2026 11:38`)?.fields).toMatchObject({
      exchangeRate: '45,7',
      comment: '03.11.2026 11:38',
    });
  });

  it('should read «Курс: 45,7» as the rate', () => {
    expect(parseFinanceReply(`${NOTICE}\nКурс: 45,7`)?.fields.exchangeRate).toBe('45,7');
  });

  it('should accept the notice without ✅ and with plain spaces', () => {
    expect(
      parseFinanceReply(NOTICE.replace('✅ ', '').replace('\u00a0', ' '))?.fields.amountDue,
    ).toBe('6 274,68 грн');
  });

  it('should use the sum the manager edited in the first line', () => {
    expect(parseFinanceReply(NOTICE.replace('6\u00a0274,68', '5 000'))?.fields.amountDue).toBe(
      '5 000 грн',
    );
  });

  it('should drop «⚠️ …» and «Офіційні документи: …» lines', () => {
    const text = `${NOTICE}\n\n⚠️ сума позицій не збігається із сумою заявки\nОфіційні документи: так\n45,7`;
    const fields = parseFinanceReply(text)?.fields;
    expect(fields).not.toHaveProperty('comment');
    expect(fields?.exchangeRate).toBe('45,7');
  });

  it('should drop a «⚠» line that lost its variation selector', () => {
    expect(parseFinanceReply(`${NOTICE}\n⚠ щось\n45,7`)?.fields).not.toHaveProperty('comment');
  });

  it('should leave out the number and the FOP when the notice has none', () => {
    const fields = parseFinanceReply(
      '✅ Ваш запит на 1\u00a0601 грн прийнято\nПрийняв: Admin',
    )?.fields;
    expect(fields).not.toHaveProperty('orderNumber');
    expect(fields).not.toHaveProperty('clientName');
  });

  it('should flag the multi-order warning for /requisites', () => {
    const text = `${NOTICE}\n⚠️ знайдено кілька номерів — зареєстровано лише перший`;
    expect(parseFinanceReply(text)?.requisites).toBe(true);
  });

  it.each(['Номер: 0000-074404', '0000-074404'])(
    'should take %p as the order number when the notice has none',
    (line) => {
      const text = `✅ Ваш запит на 1\u00a0601 грн прийнято\nФОП: x\n${line}\n45,7`;
      const fields = parseFinanceReply(text)?.fields;
      expect(fields?.orderNumber).toBe('0000-074404');
      expect(fields).not.toHaveProperty('comment');
    },
  );

  it('should keep such a line in the comment when the notice already has a number', () => {
    expect(parseFinanceReply(`${NOTICE}\n0000-074405`)?.fields).toMatchObject({
      orderNumber: '0000-074404',
      comment: '0000-074405',
    });
  });

  it('should not take a date or a sum on its own line as the rate', () => {
    expect(parseFinanceReply(`${NOTICE}\n03.11.2026 11:38\n45,7`)?.fields.exchangeRate).toBe(
      '45,7',
    );
    const fields = parseFinanceReply(`${NOTICE}\n5 000`)?.fields;
    expect(fields).not.toHaveProperty('exchangeRate');
    expect(fields?.comment).toBe('5 000');
  });

  it('should strip «Курс:» only on the rate line', () => {
    expect(parseFinanceReply(`${NOTICE}\nКурс: уточнити`)?.fields.comment).toBe('Курс: уточнити');
  });

  it('should accept «ТОВ:» as the FOP', () => {
    const text = '✅ Ваш запит на 1\u00a0601 грн прийнято\nТОВ: Абертайм';
    expect(parseFinanceReply(text)?.fields.clientName).toBe('Абертайм');
  });

  it('should flag a payouts block', () => {
    const text = `${NOTICE}\n\nРеквізити для оплати (1):\n\n1. Носенко Роман — 963 грн\n   на картку`;
    expect(parseFinanceReply(text)?.requisites).toBe(true);
  });

  it.each([
    'Номер: 0000-066717\nФОП: Абертайм\nСума: 100',
    'Підкажіть, а що значить «Ваш запит на 100 грн прийнято»?',
  ])('should not treat %p as a finance reply', (text) => {
    expect(parseFinanceReply(text)).toBeNull();
  });
});
