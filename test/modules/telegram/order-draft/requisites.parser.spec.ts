import {
  REQUISITES_MAX_LENGTH,
  hasMultipleOrdersOrRequisites,
  parseRequisites,
  type RequisitesPlan,
  withoutNumbers,
} from '../../../../src/modules/telegram/order-draft/requisites.parser';

// Real messages from managers, exactly as they were written — the same ones this whole feature was
// originally built against; "одним повідомленням" must keep reading them the same way.
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
Івченко Євгеній виплата на (ФОП Івченко Євгеній Вадимович) 75 000,00 грн

44,9`,
  oneNumberFopAndCard: `0000-066092
07.09.2026
ФОП Носенко Роман - 4 527,00 грн 14:57
4441 1110 6964 5962 Андріанов Олександр - 2 140,00 грн 14:59
45`,
  fiveNumbersTwoCards: `0000-068796
511,86 грн
0000-068891
545,08 грн
0000-069031
546,3 грн
0000-069119
573,75 грн
0000-069143
546,3 грн
Загальна сума: 2 723,29 грн
4441 1111 0377 3382  Афанасьєв Олексій (Виплата на Афанасьєва Поліна) 2 039,00 грн 21.09.2026 17:45
5355 2800 2090 0252 Денисенко Марина 684,29 грн 21.09.2026 17:45

45`,
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
const requisites = (plan: RequisitesPlan) =>
  plan.requisiteLines.map((r) => `${r.payerName}|${r.account ?? ''}|${r.amount}`);
const has = (plan: RequisitesPlan, part: string) =>
  plan.warnings.some((warning) => warning.includes(part));

describe('parseRequisites', () => {
  describe('several numbers paid together (one group)', () => {
    it('should give every number its own amount, take the written total/rate/recipient, and record no requisites', () => {
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
      expect(plan.comment).toBe('18.09.2026 21:28');
      expect(plan.requisiteLines).toEqual([]);
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

    it('should take twelve numbers as one group and warn about the real difference, not a doubled amount', () => {
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
        errors: [expect.stringContaining('Біля номера 0000-068773 немає суми') as string],
      });
    });

    it('should take the amount from the next line when a number has none of its own, and attach the third-party cards that paid for the whole group', () => {
      const plan = planOf(SAMPLES.fiveNumbersTwoCards);

      expect(plan.kind).toBe('group');
      expect(amounts(plan)).toEqual([
        '0000-068796 511.86',
        '0000-068891 545.08',
        '0000-069031 546.30',
        '0000-069119 573.75',
        '0000-069143 546.30',
      ]);
      expect(plan.total.toFixed(2)).toBe('2723.29');
      expect(plan.derivedTotal).toBe(false);
      expect(plan.rate).toBe('45');
      expect(plan.requisiteLines).toHaveLength(2);
      expect(plan.requisiteLines[0]).toMatchObject({
        account: '4441 1111 0377 3382',
        amount: '2039.00',
      });
      expect(plan.requisiteLines[0]!.payerName).toContain('Афанасьєв Олексій');
      expect(plan.requisiteLines[1]).toMatchObject({
        payerName: 'Денисенко Марина',
        account: '5355 2800 2090 0252',
        amount: '684.29',
      });
      expect(plan.warnings).toEqual([]);
    });
  });

  describe('one number paid to several recipients (one order + requisites)', () => {
    it('should add the recipients up, flag the total as worked out, and record one requisite per recipient', () => {
      const plan = planOf(SAMPLES.oneNumberTwoFops);

      expect(plan.kind).toBe('single');
      expect(amounts(plan)).toEqual(['0000-068652 118810.64']);
      expect(plan.total.toFixed(2)).toBe('118810.64');
      expect(plan.derivedTotal).toBe(true);
      expect(plan.rate).toBe('44.9');
      expect(has(plan, 'порахував')).toBe(true);
      expect(requisites(plan)).toEqual([
        'ФОП Берчатов М.М||59438.85',
        'ФОП Берчатова Л.О||59371.79',
      ]);
      expect(plan.requisiteLines[0]!.paidAt.toISOString()).toBe('2026-09-19T07:50:00.000Z');
    });

    it('should read amounts written with a dot and an amount followed by a time', () => {
      const plan = planOf(SAMPLES.oneNumberTwoRecipients);

      expect(plan.total.toFixed(2)).toBe('9048.93');
      expect(requisites(plan)).toEqual(['ФОП Пеленський А.Й||4629.04', 'ТОВ Абертайм||4419.89']);
    });

    it('should treat a restated payment as one requisite, not two, and point it out', () => {
      const plan = planOf(SAMPLES.sameAmountTwice);

      expect(plan.total.toFixed(2)).toBe('2514.62');
      expect(plan.requisiteLines).toHaveLength(1);
      expect(has(plan, 'порахував')).toBe(true);
    });

    it('should use a written total, compare it with the lines, fix a number missing a zero, and record each card as a requisite', () => {
      const plan = planOf(SAMPLES.cardsWithTypo);

      expect(plan.kind).toBe('single');
      expect(amounts(plan)).toEqual(['0000-066092 9067.00']);
      expect(plan.derivedTotal).toBe(false);
      expect(plan.rate).toBe('45');
      expect(plan.warnings).toEqual([
        'Номер «000-066092» схожий на 0000-066092 — виправив, перевірте.',
      ]);
      expect(requisites(plan)).toEqual([
        'Носенко Роман|5168 7451 7598 8366|4527.00',
        'Андріанов Олександр Ігорович|4441 1110 6964 5962|2140.00',
        'Лукін Юрій|4149 4999 9712 3011|1573.00',
        'Кравцов Богдан|4441 1144 4794 3026|827.00',
      ]);
    });

    it('should take an amount written on the number line itself, with no requisites to report', () => {
      const plan = planOf('0000-068641 809,48 грн\n44,9%');

      expect(plan.kind).toBe('single');
      expect(plan.total.toFixed(2)).toBe('809.48');
      expect(plan.derivedTotal).toBe(false);
      expect(plan.requisiteLines).toEqual([]);
    });

    it('should take a number found in the middle of a line when it is the only one', () => {
      const plan = planOf('Оплата за 0000-068641\nФОП Гук В.С - 500 грн 10:50\n44,9%');

      expect(plan.kind).toBe('single');
      expect(plan.items[0]!.number).toBe('0000-068641');
      expect(has(plan, 'не на початку рядка')).toBe(true);
      expect(requisites(plan)).toEqual(['ФОП Гук В.С||500.00']);
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

  describe('dates and amounts written loosely', () => {
    it('should read a two-digit year, a date in words, and a card payment without "грн"', () => {
      const plan = planOf(
        [
          '0000-066092',
          '5 вересня 2026',
          '5168 7451 7598 8366 Носенко Роман 4 527 14:57',
          '07.09.26',
          'ФОП Андріанов Олександр - 2 140,00 14:59',
        ].join('\n'),
      );

      expect(plan.total.toFixed(2)).toBe('6667.00');
      expect(plan.warnings).toContain(
        'Загальної суми в тексті немає — я порахував її з рядків, перевірте.',
      );
      expect(plan.requisiteLines).toEqual([
        {
          payerName: 'Носенко Роман',
          account: '5168 7451 7598 8366',
          amount: '4527.00',
          paidAt: new Date('2026-09-05T11:57:00Z'),
        },
        {
          payerName: 'ФОП Андріанов Олександр',
          account: null,
          amount: '2140.00',
          paidAt: new Date('2026-09-07T11:59:00Z'),
        },
      ]);
    });

    it('should never take a tax id or an invoice number for an amount without "грн"', () => {
      const plan = planOf(
        '0000-066092\nФОП Носенко Роман 100 грн\nЄДРПОУ 2181702573\nОплата згідно рахунку 187',
      );

      expect(plan.requisiteLines.map((r) => r.amount)).toEqual(['100.00']);
    });
  });

  describe('a message with no number', () => {
    it.each([SAMPLES.minusFourPayments, SAMPLES.minusTimeBeforeDate, SAMPLES.minusPayerInBrackets])(
      'should point at the minus-closing button instead of closing a minus here',
      (text) => {
        const result = parseRequisites(text);

        expect(result.ok).toBe(false);
        expect(!result.ok && result.errors.join(' ')).toContain('/newminus');
      },
    );
  });

  describe('one number split between a FOP and a card holder', () => {
    it('should read the number, split the two recipients into requisites, and take the comment as the date', () => {
      const plan = planOf(SAMPLES.oneNumberFopAndCard);

      expect(plan.kind).toBe('single');
      expect(plan.total.toFixed(2)).toBe('6667.00');
      expect(plan.rate).toBe('45');
      expect(plan.comment).toBe('07.09.2026');
      expect(requisites(plan)).toEqual([
        'ФОП Носенко Роман||4527.00',
        'Андріанов Олександр|4441 1110 6964 5962|2140.00',
      ]);
    });
  });

  describe('refusing what cannot be read', () => {
    it('should ask for an amount when there is none', () => {
      const result = parseRequisites('0000-068641\nФОП Гук В.С.\n44,9%');

      expect(result).toEqual({
        ok: false,
        errors: [expect.stringContaining('Не знайшов жодної суми') as string],
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

      expect(result).toEqual({ ok: false, errors: [expect.stringContaining('задовге') as string] });
    });
  });

  it('should ignore a rate that is not a valid number instead of failing', () => {
    const plan = planOf('0000-068641 100 грн\nКурс: 0');

    expect(plan.rate).toBeNull();
  });
});

describe('hasMultipleOrdersOrRequisites', () => {
  it('should flag more than one order number', () => {
    expect(hasMultipleOrdersOrRequisites(SAMPLES.severalNumbers)).toBe(true);
    expect(hasMultipleOrdersOrRequisites(SAMPLES.fiveNumbersTwoCards)).toBe(true);
  });

  it('should flag a card, an IBAN or a marker word even with one number or none', () => {
    expect(hasMultipleOrdersOrRequisites(SAMPLES.oneNumberFopAndCard)).toBe(true);
    expect(hasMultipleOrdersOrRequisites(SAMPLES.minusTimeBeforeDate)).toBe(true);
    expect(hasMultipleOrdersOrRequisites('Оплата клієнта ЄДРПОУ 12345678')).toBe(true);
  });

  it('should leave a single number with no card/IBAN/marker alone', () => {
    expect(hasMultipleOrdersOrRequisites('0000-066717\nЧернявський Владислав\n6 158,41 грн')).toBe(
      false,
    );
    expect(hasMultipleOrdersOrRequisites('привіт, як справи?')).toBe(false);
  });
});

describe('withoutNumbers', () => {
  it('should drop the named numbers and the total line, keeping everything else', () => {
    const text = withoutNumbers(SAMPLES.severalNumbers, ['0000-068773']);

    expect(text).not.toContain('0000-068773');
    expect(text).not.toContain('Загальна сума');
    expect(text).toContain('0000-068772');
    expect(text).toContain('Гук Віктор Степанович ФОП');
  });
});
