import {
  type MinusPlan,
  parseMinusClosing,
} from '../../../../src/modules/telegram/order-draft/minus-closing.parser';

// Real messages from managers, exactly as they were written.
const SAMPLES = {
  ourFopWithPeriod: `Закриття мінусу Uft Uft за період 07.09. https://docs.google.com/spreadsheets/d/1-4qzSI2KGMHAd9gXnyf1AfQpftVX6vSVotaFFETSuRg/edit?gid=0#gid=0
09.09.2026 18:08
41 812,02 грн.
ФОП Пеленський А. Й.`,
  card: `Закриття мінусу Кожушко Игорь https://docs.google.com/spreadsheets/d/1JcYPrRzbaaUxaJcgKKxMIrFwIYLEO20OwGNqFpzCtRs/edit?gid=0#gid=0
06.09.2025 11:47
 2 287,00 Грн
5168 7451 7598 8366 Носенко Роман 2 287,00 Грн
без %`,
  withReferenceNumber: `Закриття мінусу клієнта Гук Руслан за підрахунком 31 серпня 2026
0000-065607
05.09.2026 12.:36
27 409 грн. (з урахуванням 1%)
ФОП берчатов м. М
https://docs.google.com/spreadsheets/d/1XOUzGdwIxig5UCvUR6Iw5iW9t2tKdWWiHvVILzGq9m0/edit?gid=0#gid=0`,
  template: `Закриття заборгованості клієнта
ПІБ (ФОП): Гук Руслан за підрахунком 31.08.2026
Дата: 05.09.2026 12:36
Загальна Сума: 2 140 грн
Оплату отримано на:

4441 1110 6964 5962 Андріанов Олександр 2 140,00 грн 14:59

Коментар: з урахуванням 1%

Курс: 44,9
Посилання на таблицю: https://docs.google.com/x`,
  bankDetails: `Оплата мінусу клієнта Вівчарук Валентин за 12.09:

15.09.2026 12:16
ФОП Чулінда Вадим Павлович  29 500,00 грн
"""UA383052990000026004001606383
ЄДРПОУ 2181702573
Призначення:
Оплата за товар згідно Рахунку № 187 від 11 вересня 2026 р"""

15.09.2026 00:08
ФОП Івченко Євгеній Вадимович 6 961,00 грн
"UA573052990000026005031228837
3153718452
Призначення платежу : Оплата за товар"`,
  cardWithoutAmount: `Рабодзей Паша за підрахунком 7 вересня 2026 року
09.09.2026 16:00
13 377 грн
На карту Тимчеко Юрій Ігорович 4149 6090 5310 7860 
Без %
44,90
https://docs.google.com/spreadsheets/d/17cF94ahYg0fxSsGqIhtrtt4Qz4A5VNroueYod1G7bXs/edit?gid=0#gid=0`,
};

const planOf = (text: string): MinusPlan => {
  const result = parseMinusClosing(text);
  if (!result.ok) {
    throw new Error(result.errors.join('; '));
  }
  return result.plan;
};

describe('parseMinusClosing', () => {
  it('should read our FOP, the period and the spreadsheet out of a freeform message', () => {
    const plan = planOf(SAMPLES.ourFopWithPeriod);

    expect(plan).toMatchObject({
      clientName: 'Uft Uft',
      period: 'за період 07.09',
      paidAt: new Date('2026-09-09T15:08:00Z'),
      ourFop: 'Пеленський А. Й.',
      requisiteLines: [],
      comment: null,
      sheetUrl:
        'https://docs.google.com/spreadsheets/d/1-4qzSI2KGMHAd9gXnyf1AfQpftVX6vSVotaFFETSuRg/edit?gid=0#gid=0',
      warnings: [],
    });
    expect(plan.total.toFixed(2)).toBe('41812.02');
  });

  it('should tell the total line from a card payment line with the same amount', () => {
    const plan = planOf(SAMPLES.card);

    expect(plan.clientName).toBe('Кожушко Игорь');
    expect(plan.total.toFixed(2)).toBe('2287.00');
    expect(plan.ourFop).toBeNull();
    expect(plan.requisiteLines).toEqual([
      {
        payerName: 'Носенко Роман',
        account: '5168 7451 7598 8366',
        amount: '2287.00',
        paidAt: new Date('2025-09-06T08:47:00Z'),
      },
    ]);
    expect(plan.comment).toBe('без %');
    expect(plan.warnings).toEqual([]);
  });

  it('should keep a 1C number and the note after the amount as a comment, and forgive "12.:36"', () => {
    const plan = planOf(SAMPLES.withReferenceNumber);

    expect(plan.clientName).toBe('Гук Руслан');
    expect(plan.period).toBe('за підрахунком 31 серпня 2026');
    expect(plan.paidAt).toEqual(new Date('2026-09-05T09:36:00Z'));
    expect(plan.total.toFixed(2)).toBe('27409.00');
    expect(plan.ourFop).toBe('берчатов м. М');
    expect(plan.comment).toBe('№ 0000-065607 · з урахуванням 1%');
  });

  it('should take the one card named without an amount as where the whole sum went', () => {
    const plan = planOf(SAMPLES.cardWithoutAmount);

    expect(plan).toMatchObject({
      clientName: 'Рабодзей Паша',
      period: 'за підрахунком 7 вересня 2026 року',
      paidAt: new Date('2026-09-09T13:00:00Z'),
      ourFop: null,
      comment: 'Без %',
      rate: '44.90',
      warnings: [],
    });
    expect(plan.total.toFixed(2)).toBe('13377.00');
    expect(plan.requisiteLines).toEqual([
      {
        payerName: 'Тимчеко Юрій Ігорович',
        account: '4149 6090 5310 7860',
        amount: '13377.00',
        paidAt: new Date('2026-09-09T13:00:00Z'),
      },
    ]);
  });

  it('should read the labelled template, taking a payment’s own time over the date line’s', () => {
    const plan = planOf(SAMPLES.template);

    expect(plan).toMatchObject({
      clientName: 'Гук Руслан',
      period: 'за підрахунком 31.08.2026',
      paidAt: new Date('2026-09-05T09:36:00Z'),
      ourFop: null,
      comment: 'з урахуванням 1%',
      rate: '44.9',
      sheetUrl: 'https://docs.google.com/x',
      warnings: [],
    });
    expect(plan.requisiteLines).toEqual([
      {
        payerName: 'Андріанов Олександр',
        account: '4441 1110 6964 5962',
        amount: '2140.00',
        paidAt: new Date('2026-09-05T11:59:00Z'),
      },
    ]);
  });

  it('should read the short labels the /newminus hint shows', () => {
    const plan = planOf(
      [
        'Клієнт: Гук Руслан за підрахунком 31.08.2026',
        'Дата: 05.09.2026 12:36',
        'Сума: 27 409 грн',
        'Отримано на: ФОП Берчатов М. М.',
        'Коментар: з урахуванням 1%',
        'Курс: 44,9',
        'Таблиця: https://docs.google.com/x',
      ].join('\n'),
    );

    expect(plan).toMatchObject({
      clientName: 'Гук Руслан',
      period: 'за підрахунком 31.08.2026',
      paidAt: new Date('2026-09-05T09:36:00Z'),
      ourFop: 'Берчатов М. М.',
      comment: 'з урахуванням 1%',
      rate: '44.9',
      sheetUrl: 'https://docs.google.com/x',
      warnings: [],
    });
    expect(plan.total.toFixed(2)).toBe('27409.00');
  });

  it('should read a two-digit year and a date written in words', () => {
    expect(planOf('Клієнт: Гук\nСума: 100 грн\nДата: 05.09.26 12:36').paidAt).toEqual(
      new Date('2026-09-05T09:36:00Z'),
    );
    expect(planOf('Клієнт: Гук\nСума: 100 грн\n5 вересня 2026 р.').paidAt).toEqual(
      new Date('2026-09-04T21:00:00Z'),
    );
  });

  it('should read a payment line without "грн" and date it by the closing when it has no date', () => {
    const plan = planOf(
      'Клієнт: Гук\n5168 7451 7598 8366 Носенко Роман 2 287\nФОП Пеленський А. Й. - 1 000,50\nДата: 05.09.2026 12:36',
    );

    expect(plan.ourFop).toBeNull();
    expect(plan.requisiteLines).toEqual([
      {
        payerName: 'Носенко Роман',
        account: '5168 7451 7598 8366',
        amount: '2287.00',
        paidAt: new Date('2026-09-05T09:36:00Z'),
      },
      {
        payerName: 'ФОП Пеленський А. Й.',
        account: null,
        amount: '1000.50',
        paidAt: new Date('2026-09-05T09:36:00Z'),
      },
    ]);
    expect(plan.total.toFixed(2)).toBe('3287.50');
  });

  it('should read "ФОП:" with a colon as the client, and "ФОП …" without one as our FOP', () => {
    const plan = planOf('ФОП: Гук Руслан\nСума: 100 грн\nФОП Берчатов М. М.');

    expect(plan.clientName).toBe('Гук Руслан');
    expect(plan.ourFop).toBe('Берчатов М. М.');
  });

  it('should take "Оплату отримано на: ФОП …" as our FOP', () => {
    const plan = planOf('ПІБ: Гук Руслан\nСума: 100 грн\nОплату отримано на: ФОП Берчатов М. М.');

    expect(plan.ourFop).toBe('Берчатов М. М.');
  });

  it('should add up payments copied with bank details, and keep those details out of the comment', () => {
    const plan = planOf(SAMPLES.bankDetails);

    expect(plan.clientName).toBe('Вівчарук Валентин');
    expect(plan.period).toBe('за 12.09');
    expect(plan.total.toFixed(2)).toBe('36461.00');
    expect(plan.comment).toBeNull();
    expect(plan.requisiteLines.map((r) => r.account)).toEqual([
      'UA383052990000026004001606383',
      'UA573052990000026005031228837',
    ]);
    expect(plan.warnings[0]).toContain('порахував');
  });

  it('should take the first plain line as the client when there is no header', () => {
    const plan = planOf('Гук Руслан\n27 409 грн\nФОП Берчатов М. М.');

    expect(plan.clientName).toBe('Гук Руслан');
    expect(plan.ourFop).toBe('Берчатов М. М.');
    expect(plan.warnings).toEqual(['Не вказано дату оплати.']);
  });

  it('should warn when the written total and the payments disagree', () => {
    const plan = planOf('ПІБ: Гук Руслан\nЗагальна сума: 5 000 грн\nФОП А - 3 000 грн');

    expect(plan.total.toFixed(2)).toBe('5000.00');
    expect(plan.warnings).toContain(
      'Платежі разом 3 000 грн, а сума 5 000 грн (різниця 2 000 грн).',
    );
  });

  it('should keep only an http(s) address as the spreadsheet, and an unreadable rate as a comment', () => {
    const plan = planOf(
      'ПІБ: Гук Руслан\nСума: 100 грн\nКурс: без %\nПосилання на таблицю: javascript:alert(1)',
    );

    expect(plan.sheetUrl).toBeNull();
    expect(plan.rate).toBeNull();
    expect(plan.comment).toBe('Курс: без %');
    expect(plan.warnings).toContain('«javascript:alert(1)» не схоже на посилання, пропускаю.');
  });

  it.each([
    ['27 409 грн\nФОП Берчатов', 'Не знайшов клієнта'],
    ['Закриття мінусу Гук Руслан\nФОП Берчатов', 'Не знайшов суму'],
  ])('should refuse a message without a client or an amount', (text, error) => {
    const result = parseMinusClosing(text);

    expect(result.ok).toBe(false);
    expect(!result.ok && result.errors.join(' ')).toContain(error);
  });

  describe('dollars', () => {
    it('should read a closing in dollars, with the "$" before the sum', () => {
      const plan = planOf(
        'Закриття мінусу клієнта Гук Руслан\n05.09.2026 12:36\nСума: $1 500\nОтримано на: ФОП Берчатов М. М.',
      );

      expect(plan).toMatchObject({
        clientName: 'Гук Руслан',
        currency: 'USD',
        ourFop: 'Берчатов М. М.',
      });
      expect(plan.total.toFixed(2)).toBe('1500.00');
    });

    it('should read card payments in dollars and word the mismatch in dollars', () => {
      const plan = planOf(
        'Клієнт: Гук Руслан\nДата: 05.09.2026\nЗагальна сума: 150 $\n4441 1110 6964 5962 Андріанов Олександр 100 $ 14:59',
      );

      expect(plan.currency).toBe('USD');
      expect(plan.requisiteLines).toEqual([
        expect.objectContaining({ payerName: 'Андріанов Олександр', amount: '100.00' }),
      ]);
      expect(plan.warnings).toEqual(
        expect.arrayContaining([expect.stringContaining('різниця 50 $')]),
      );
    });

    it('should stay in hryvnias by default and refuse mixing the two', () => {
      expect(planOf(SAMPLES.template).currency).toBe('UAH');
      expect(parseMinusClosing('Клієнт: Гук\nСума: 100 грн\n50 $')).toEqual({
        ok: false,
        errors: ['Гривні й долари в одному повідомленні — надішліть окремо.'],
      });
    });
  });
});
