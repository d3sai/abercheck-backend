import {
  looksLikeRequisites,
  parseRequisites,
  REQUISITES_MAX_LENGTH,
  type RequisitesPlan,
} from '../../../../src/modules/telegram/order-draft/requisites.parser';

// Real messages from managers, exactly as they were written.
const SAMPLES = {
  severalNumbers: `0000-068772 335,58 грн.
0000-068773 971,83 грн.
0000-068774 605,41 грн.
Загальна сума: 1 912,82 грн

18.09.2026 21:28
Гук Віктор Степанович ФОП
44,9%`,
  oneNumberTwoFops: `0000-068652
19.09.2026
ФОП Берчатов М.М - 59 438.85 грн 10:50
ФОП Берчатова Л.О - 59 371.79 грн 10:50
44,9%`,
  oneNumberTwoRecipients: `0000-068792
19.09.2026
ФОП Пеленський А.Й - 4 629.04 грн 09:05
ТОВ Абертайм - 4 419.89 грн 09:06
44,9%`,
  sameAmountTwice: `0000-068662
18.09.2026
ТОВ Абертайм -  2514,62 грн 10:12
ТОВ Абертайм -  2514,62 грн 10:11
44,9%`,
  totalWithoutCurrency: `0000-068641 809,48 грн
0000-068642  609,95 грн
0000-068667  578,2 грн
Загальна сума: 1 997,63

17.09.2026 17:36
Гук Віктор Степанович ФОП
44,9%`,
  minusFourPayments: `Оплата мінусу клієнта Вівчарук Валентин за 12.09:

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
Призначення платежу : Оплата за товар"

15.09.2026 00:08
ФОП Чегринець Ангеліна Олександрівна 1 303,00 грн
"UA983220010000026001350007371
ЄДРПОУ:
3614004982"
Призначення платежу  :  Оплата за товар
Кухарчук Олексій (Виплата на ФОП Чегринець Ангеліна Олександрівна) 1 303,00 грн

15.09.2026 00:09
4149 4975 2362 4981 Загайчук Сергій Володим`,
  minusTimeBeforeDate: `Закрила Любов Андрейчук :

ФОП Солтик Олександра Олегівна 4 890,00  грн  13:04  17.09.2026

"IBAN:
UA549358710000067320000088286
ІПН / ЄДРПОУ:
3854704584
Платіжна установа:
ТОВ НоваПей
Призначення платежу :  Оплата за товар
"`,
  minusPayerInBrackets: `Закрила Любов Андрейчук :

Кравцов Богдан ( Виплата на ФОП Руслан Гниденко)  1 954,00  грн  12:19  17.09.2026

"IBAN; UA263052990000026005005934414
РНОКПП/ЄДРПОУ
3431206092
Призначення платежу :  Оплата за товар
"`,
  twoNumbersSpacedPercent: `0000-068481  578,2 грн.
0000-068562  392,27 грн.
16.09.2026 21:35
Загальна сума: 970,47 грн
ФОП Гук В. С.
44,9 %`,
  cardsWithTypo: `000-066092
Загальна сума: 9 067 грн

5168 7451 7598 8366 Носенко Роман 4 527,00 грн 07.09.2026 14:57
4441 1110 6964 5962 Андріанов Олександр Ігорович 2 140,00 грн 07.09.2026 14:59
4149 4999 9712 3011  Лукін Юрій 1 573,00 грн  07.09.2026 14:59
4441 1144 4794 3026  Кравцов Богдан 827,00 грн 07.09.2026 15:00

45`,
  twelveNumbersOnePayment: `0000-063555  20 639 грн (залишок)
0000-064272  2 044,29 грн
0000-064579  2 044,29 грн
0000-064580  2 723,63 грн
0000-064581  2 600,16 грн
0000-064592  11 393,36 грн
0000-064067  19 135,03 грн
0000-064858  2 723,63 грн
0000-065003  2 835,88 грн
0000-065004  2 402,59 грн
0000-065239  2 627,09 грн
0000-058417  3 831,32 грн

27/08/2026 16:33
ФОП Івченко Євгеній Вадимович 75 000,00 грн
"UA573052990000026005031228837
3153718452
Призначення платежу : Оплата за товар"
Ів`,
};

function planOf(text: string): RequisitesPlan {
  const result = parseRequisites(text);
  if (!result.ok) {
    throw new Error(`expected a plan, got errors: ${result.errors.join(' | ')}`);
  }
  return result.plan;
}

const amounts = (plan: RequisitesPlan) =>
  plan.items.map((item) => `${item.number} ${item.amount.toFixed(2)}`);
const has = (plan: RequisitesPlan, part: string) =>
  plan.warnings.some((warning) => warning.includes(part));

describe('parseRequisites', () => {
  describe('several numbers paid together (one group)', () => {
    it('should give every number its own amount and take the written total, rate and recipient', () => {
      const plan = planOf(SAMPLES.severalNumbers);

      expect(plan.kind).toBe('group');
      expect(amounts(plan)).toEqual([
        '0000-068772 335.58',
        '0000-068773 971.83',
        '0000-068774 605.41',
      ]);
      expect(plan.total.toFixed(2)).toBe('1912.82');
      expect(plan.derivedTotal).toBe(false);
      expect(plan.rate).toBe('44.9');
      expect(plan.label).toBe('Гук Віктор Степанович ФОП');
      expect(plan.warnings).toEqual([]);
    });

    it('should read a total written without the currency word', () => {
      const plan = planOf(SAMPLES.totalWithoutCurrency);

      expect(plan.kind).toBe('group');
      expect(amounts(plan)).toEqual([
        '0000-068641 809.48',
        '0000-068642 609.95',
        '0000-068667 578.20',
      ]);
      expect(plan.warnings).toEqual([]);
    });

    it('should read a rate written with a space before the percent sign', () => {
      const plan = planOf(SAMPLES.twoNumbersSpacedPercent);

      expect(plan.rate).toBe('44.9');
      expect(plan.total.toFixed(2)).toBe('970.47');
      expect(plan.label).toBe('ФОП Гук В. С.');
      expect(plan.warnings).toEqual([]);
    });

    it('should take twelve numbers as one group and warn about a difference from the payment', () => {
      const plan = planOf(SAMPLES.twelveNumbersOnePayment);

      expect(plan.kind).toBe('group');
      expect(plan.items).toHaveLength(12);
      expect(plan.items[0]).toMatchObject({ number: '0000-063555' });
      expect(plan.items[0]!.amount.toFixed(2)).toBe('20639.00');
      expect(plan.total.toFixed(2)).toBe('75000.27');
      expect(plan.label).toBe('ФОП Івченко Євгеній Вадимович');
      expect(plan.warnings).toEqual([
        'Сума номерів 75 000,27 грн, а оплата 75 000 грн — різниця 0,27 грн.',
      ]);
    });

    it('should warn when the written total differs from the numbers, without refusing', () => {
      const plan = planOf(SAMPLES.severalNumbers.replace('1 912,82', '1 900,00'));

      expect(plan.total.toFixed(2)).toBe('1912.82');
      expect(plan.warnings).toEqual([
        'Сума номерів 1 912,82 грн, а загальна 1 900 грн — різниця 12,82 грн.',
      ]);
    });

    it('should refuse a group where a number has no amount next to it', () => {
      const result = parseRequisites('0000-068772 335,58 грн\n0000-068773\n44,9%');

      expect(result).toEqual({
        ok: false,
        errors: [expect.stringContaining('Біля номера 0000-068773 немає суми')],
      });
    });
  });

  describe('one number paid to several recipients (one order)', () => {
    it('should add the recipients up and say the total was worked out, not written', () => {
      const plan = planOf(SAMPLES.oneNumberTwoFops);

      expect(plan.kind).toBe('single');
      expect(amounts(plan)).toEqual(['0000-068652 118810.64']);
      expect(plan.total.toFixed(2)).toBe('118810.64');
      expect(plan.derivedTotal).toBe(true);
      expect(plan.amountLines.map((a) => a.toFixed(2))).toEqual(['59438.85', '59371.79']);
      expect(plan.rate).toBe('44.9');
      expect(plan.label).toBe('ФОП Берчатов М.М +1');
      expect(has(plan, 'порахував')).toBe(true);
    });

    it('should read amounts written with a dot and an amount followed by a time', () => {
      const plan = planOf(SAMPLES.oneNumberTwoRecipients);

      expect(plan.total.toFixed(2)).toBe('9048.93');
      expect(plan.label).toBe('ФОП Пеленський А.Й +1');
    });

    it('should point out the same amount appearing twice', () => {
      const plan = planOf(SAMPLES.sameAmountTwice);

      expect(plan.total.toFixed(2)).toBe('5029.24');
      expect(has(plan, 'Сума 2 514,62 грн зустрічається 2 рази')).toBe(true);
    });

    it('should use a written total, compare it with the lines and fix a number missing a zero', () => {
      const plan = planOf(SAMPLES.cardsWithTypo);

      expect(plan.kind).toBe('single');
      expect(amounts(plan)).toEqual(['0000-066092 9067.00']);
      expect(plan.derivedTotal).toBe(false);
      expect(plan.amountLines.map((a) => a.toFixed(2))).toEqual([
        '4527.00',
        '2140.00',
        '1573.00',
        '827.00',
      ]);
      expect(plan.rate).toBe('45');
      expect(plan.label).toBe('Носенко Роман +3');
      expect(plan.warnings).toEqual([
        'Номер «000-066092» схожий на 0000-066092 — виправив, перевірте.',
      ]);
    });

    it('should take an amount written on the number line itself', () => {
      const plan = planOf('0000-068641 809,48 грн\n44,9%');

      expect(plan.kind).toBe('single');
      expect(plan.total.toFixed(2)).toBe('809.48');
      expect(plan.derivedTotal).toBe(false);
    });

    it('should take a number found in the middle of a line when it is the only one', () => {
      const plan = planOf('Оплата за 0000-068641\nФОП Гук В.С - 500 грн 10:50\n44,9%');

      expect(plan.kind).toBe('single');
      expect(plan.items[0]!.number).toBe('0000-068641');
      expect(has(plan, 'не на початку рядка')).toBe(true);
    });

    it('should not guess between several numbers hidden inside lines', () => {
      const result = parseRequisites('Оплата за 0000-068641 і 0000-068642\nФОП Гук - 500 грн');

      expect(result.ok).toBe(false);
    });

    it('should count a number written twice once', () => {
      const plan = planOf('0000-068641 100 грн\n0000-068641 100 грн');

      expect(plan.kind).toBe('single');
      expect(has(plan, 'кілька разів')).toBe(true);
    });
  });

  describe('closing a minus (no number)', () => {
    it('should add up four payments but warn about the repeated amount and the card without one', () => {
      const plan = planOf(SAMPLES.minusFourPayments);

      expect(plan.kind).toBe('minus');
      expect(plan.items).toEqual([]);
      expect(plan.amountLines.map((a) => a.toFixed(2))).toEqual([
        '29500.00',
        '6961.00',
        '1303.00',
        '1303.00',
      ]);
      expect(plan.total.toFixed(2)).toBe('39067.00');
      expect(plan.derivedTotal).toBe(true);
      expect(plan.rate).toBeNull();
      expect(plan.label).toBe('Оплата мінусу клієнта Вівчарук Валентин за 12.09');
      expect(has(plan, 'Сума 1 303 грн зустрічається 2 рази')).toBe(true);
      expect(has(plan, '4149 4975 2362 4981')).toBe(true);
      expect(has(plan, 'порахував')).toBe(true);
    });

    it.each([
      [SAMPLES.minusTimeBeforeDate, '4890.00'],
      [SAMPLES.minusPayerInBrackets, '1954.00'],
    ])('should read a payment with the time before the date', (text, total) => {
      const plan = planOf(text);

      expect(plan.kind).toBe('minus');
      expect(plan.total.toFixed(2)).toBe(total);
      expect(plan.label).toBe('Закрила Любов Андрейчук');
    });

    it('should never take an IBAN, a tax id or a court number for an amount', () => {
      const plan = planOf(SAMPLES.minusTimeBeforeDate);

      expect(plan.amountLines.map((a) => a.toFixed(2))).toEqual(['4890.00']);
    });

    it('should prefer a written total over the sum of the lines', () => {
      const plan = planOf(
        'Оплата мінусу\nЗагальна сума: 5 000 грн\nФОП А - 3 000 грн\nФОП Б - 1 900 грн',
      );

      expect(plan.total.toFixed(2)).toBe('5000.00');
      expect(plan.derivedTotal).toBe(false);
      expect(plan.warnings).toEqual([
        'Сума рядків 4 900 грн, а загальна 5 000 грн — різниця 100 грн.',
      ]);
    });
  });

  describe('reading amounts', () => {
    it('should not glue a time in front of an amount to it', () => {
      const plan = planOf('Оплата мінусу\nФОП Гук 10:50 500 грн');

      expect(plan.total.toFixed(2)).toBe('500.00');
    });

    it('should not glue a date in front of an amount to it', () => {
      const plan = planOf('Оплата мінусу\n17.09.2026 4 890,00 грн');

      expect(plan.total.toFixed(2)).toBe('4890.00');
    });

    it('should accept thousands separated by a non-breaking space', () => {
      const plan = planOf('Оплата мінусу\nФОП Гук 12 345,60 грн');

      expect(plan.total.toFixed(2)).toBe('12345.60');
    });

    it('should accept an amount with one decimal digit and a trailing dot', () => {
      const plan = planOf('Оплата мінусу\nФОП Гук 578,2 грн.');

      expect(plan.total.toFixed(2)).toBe('578.20');
    });

    it('should read a labelled total and a labelled rate', () => {
      const plan = planOf('0000-068641\nСума: 6 158,41\nКурс: 44,9');

      expect(plan.total.toFixed(2)).toBe('6158.41');
      expect(plan.rate).toBe('44.9');
    });

    it('should not mistake a lone amount for a rate', () => {
      const plan = planOf('0000-068641\nФОП Гук - 500 грн\n335,58');

      expect(plan.rate).toBeNull();
    });
  });

  describe('refusing what cannot be read', () => {
    it('should ask for an amount when there is none', () => {
      const result = parseRequisites('0000-068641\nФОП Гук В.С.\n44,9%');

      expect(result).toEqual({
        ok: false,
        errors: [expect.stringContaining('Не знайшов жодної суми')],
      });
    });

    it('should ask for an amount when a message with no number has none', () => {
      expect(parseRequisites('Оплата мінусу клієнта Іваненко').ok).toBe(false);
    });

    it('should refuse an amount that is too large to store', () => {
      const result = parseRequisites('Оплата мінусу\nФОП Гук 1 234 567 890 123,00 грн');

      expect(result.ok).toBe(false);
    });

    it('should refuse an overlong message', () => {
      const result = parseRequisites(`0000-068641 100 грн\n${'а'.repeat(REQUISITES_MAX_LENGTH)}`);

      expect(result).toEqual({
        ok: false,
        errors: [expect.stringContaining('задовге')],
      });
    });
  });

  it('should ignore a rate that is not a valid number instead of failing', () => {
    const plan = planOf('0000-068641 100 грн\nКурс: 0');

    expect(plan.rate).toBeNull();
  });
});

describe('sections of the message', () => {
  it('should turn the example from the manager into recipients, amount, rate and comment', () => {
    const plan = planOf(`0000-066092
07.09.2026
ФОП Носенко Роман - 4 527,00 грн 14:57
4441 1110 6964 5962 Андріанов Олександр - 2 140,00 грн 14:59
45`);

    expect(plan.items.map((item) => item.number)).toEqual(['0000-066092']);
    expect(plan.total.toFixed(2)).toBe('6667.00');
    expect(plan.rate).toBe('45');
    expect(plan.comment).toBe('07.09.2026');
    expect(plan.requisites).toBe(
      [
        'ФОП Носенко Роман - 4 527,00 грн 14:57',
        '4441 1110 6964 5962 Андріанов Олександр - 2 140,00 грн 14:59',
      ].join('\n'),
    );
  });

  it('should put the date of a group into the comment and keep the recipient as the details', () => {
    const plan = planOf(SAMPLES.severalNumbers);

    expect(plan.comment).toBe('18.09.2026 21:28');
    expect(plan.requisites).toBe('Гук Віктор Степанович ФОП');
  });

  it('should keep several dates with their own payments instead of picking one for the comment', () => {
    const plan = planOf(SAMPLES.minusFourPayments);

    expect(plan.comment).toBe('Оплата мінусу клієнта Вівчарук Валентин за 12.09');
    expect(plan.requisites.startsWith('15.09.2026 12:16\nФОП Чулінда')).toBe(true);
    expect(plan.requisites).toContain('15.09.2026 00:08');
    expect(plan.requisites).toContain('15.09.2026 00:09');
    expect(plan.requisites).toContain('Кухарчук Олексій (Виплата на ФОП');
  });

  it('should take the header of a minus closing as the comment and keep the payment as the details', () => {
    const plan = planOf(SAMPLES.minusTimeBeforeDate);

    expect(plan.comment).toBe('Закрила Любов Андрейчук');
    expect(plan.requisites.startsWith('ФОП Солтик Олександра Олегівна 4 890,00  грн')).toBe(true);
    expect(plan.requisites).toContain('UA549358710000067320000088286');
  });

  it('should join a written comment with the date', () => {
    const plan = planOf('0000-068641 100 грн\n07.09.2026\nФОП Гук\nКоментар: Терміново');

    expect(plan.comment).toBe('07.09.2026 · Терміново');
    expect(plan.requisites).toBe('ФОП Гук');
  });

  it('should keep the note written after the amount of a number', () => {
    const plan = planOf(SAMPLES.twelveNumbersOnePayment);

    expect(plan.items[0]!.note).toBe('(залишок)');
    expect(plan.items.slice(1).every((item) => item.note === null)).toBe(true);
    expect(plan.comment).toBe('27/08/2026 16:33');
    expect(plan.requisites).toContain('ФОП Івченко Євгеній Вадимович 75 000,00 грн');
    expect(plan.requisites.endsWith('Ів')).toBe(true);
  });

  it('should leave the details empty when the message holds nothing else', () => {
    const plan = planOf('0000-068641 100 грн\n44,9%');

    expect(plan.requisites).toBe('');
    expect(plan.comment).toBeNull();
  });

  it('should lose no line: everything that was not read out stays in the details', () => {
    const plan = planOf(SAMPLES.minusPayerInBrackets);

    expect(plan.requisites).toContain('Кравцов Богдан ( Виплата на ФОП Руслан Гниденко)');
    expect(plan.requisites).toContain('РНОКПП/ЄДРПОУ');
    expect(plan.requisites).toContain('3431206092');
    expect(plan.requisites).toContain('Призначення платежу :  Оплата за товар');
  });
});

describe('a payment amount written twice', () => {
  const TWICE = `${SAMPLES.twelveNumbersOnePayment.replace('\nІв', '')}
Івченко Євгеній виплата на (ФОП Івченко Євгеній Вадимович) 75 000,00 грн

44,9`;

  it('should not report the doubled amount as the difference, only the real 0,27', () => {
    const plan = planOf(TWICE);

    expect(plan.kind).toBe('group');
    expect(plan.total.toFixed(2)).toBe('75000.27');
    expect(plan.warnings).toEqual([
      'Сума 75 000 грн зустрічається 2 рази — це різні платежі?',
      'Сума номерів 75 000,27 грн, а оплата 75 000 грн — різниця 0,27 грн.',
    ]);
    expect(plan.rate).toBe('44.9');
  });
});

describe('looksLikeRequisites', () => {
  it.each([
    ['several numbers', SAMPLES.severalNumbers],
    ['one number and two recipients', SAMPLES.oneNumberTwoFops],
    ['the same amount twice', SAMPLES.sameAmountTwice],
    ['an IBAN', SAMPLES.minusTimeBeforeDate],
    ['cards', SAMPLES.cardsWithTypo],
    ['twelve numbers', SAMPLES.twelveNumbersOnePayment],
    ['only a card line', '4149 4975 2362 4981 Загайчук Сергій'],
    ['a tax id marker', 'Оплата мінусу\nІПН 3854704584\nФОП Гук 500 грн'],
  ])('should recognise %s', (_name, text) => {
    expect(looksLikeRequisites(text)).toBe(true);
  });

  it.each([
    ['the regular template', '0000-066717\nЧернявський Владислав\n6 158,41 грн\n44,9\nТерміново'],
    ['a template without the currency', '0000-066717\nЧернявський Владислав\n6158,41\n44,9'],
    ['a minus closing', 'Чернявський Владислав\n6 158,41 грн'],
    ['a labelled template', 'Номер: 0000-066717\nФОП: Чернявський\nСума: 6 158,41 грн'],
    ['chat text', 'привіт, як справи?'],
  ])('should leave %s alone', (_name, text) => {
    expect(looksLikeRequisites(text)).toBe(false);
  });
});
