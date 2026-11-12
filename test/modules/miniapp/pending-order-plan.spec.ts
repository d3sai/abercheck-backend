import { Prisma } from '../../../src/generated/prisma/client';
import { type OrderPlan } from '../../../src/modules/miniapp/miniapp.dto';
import { fromStoredPlan, toStoredPlan } from '../../../src/modules/miniapp/pending-order-plan';

const dec = (value: string) => new Prisma.Decimal(value);
const paidAt = new Date('2026-01-15T12:30:00.000Z');

const kit: OrderPlan = {
  kind: 'kit',
  plan: {
    accessCode: '647143353',
    total: dec('3176.71'),
    items: [
      { number: '0000-062265', amount: dec('2696.71') },
      { number: '0000-062937', amount: dec('480') },
    ],
    paidAt,
    comment: null,
    warnings: [],
  },
};
const cash: OrderPlan = {
  kind: 'cash',
  plan: {
    number: '0000-066498',
    amount: dec('4260'),
    currency: 'UAH',
    rate: '44.9',
    paidAt: null,
    handedBy: 'Христина Павлів',
    withPercent: true,
    comment: 'у конверті',
    warnings: [],
  },
};
const foreign: OrderPlan = {
  kind: 'foreign',
  plan: {
    number: '0000-066498',
    amount: dec('100'),
    currency: 'EUR',
    recipient: 'Абертайм ТОВ',
    rate: '44.9',
    paidAt,
    comment: null,
    warnings: [],
  },
};

const roundTrip = (order: OrderPlan) =>
  fromStoredPlan(JSON.parse(JSON.stringify(toStoredPlan(order))) as unknown);

describe('pending order plan', () => {
  it.each([kit, cash, foreign])('should round-trip a $kind plan through JSON', (order) => {
    const back = roundTrip(order)!;

    expect(back.kind).toBe(order.kind);
    expect(JSON.stringify(toStoredPlan(back))).toBe(JSON.stringify(toStoredPlan(order)));
  });

  it('should bring amounts back as Decimal and dates back as Date', () => {
    const back = roundTrip(kit)!;

    if (back.kind !== 'kit') throw new Error('expected kit');
    expect(back.plan.total).toBeInstanceOf(Prisma.Decimal);
    expect(back.plan.items[1]!.amount.equals(dec('480'))).toBe(true);
    expect(back.plan.paidAt!.getTime()).toBe(paidAt.getTime());
  });

  it('should keep a missing paid date null', () => {
    const back = roundTrip(cash)!;

    if (back.kind !== 'cash') throw new Error('expected cash');
    expect(back.plan.paidAt).toBeNull();
    expect(back.plan.amount.equals(dec('4260'))).toBe(true);
  });

  it.each([[{ kind: 'unknown' }], [null], ['text'], [{ kind: 'kit' }]])(
    'should answer null for a damaged value %j',
    (value) => {
      expect(fromStoredPlan(value)).toBeNull();
    },
  );
});
