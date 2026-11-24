import { storedPayments } from '../../../src/modules/finance-sync/stored-payments';

describe('storedPayments', () => {
  const row = {
    payerName: 'Іван',
    account: null,
    amount: '5.00',
    paidAt: '2026-11-04T08:15:00.000Z',
  };

  it('should return the stored rows', () => {
    expect(storedPayments([row])).toEqual([row]);
  });

  it.each([null, undefined, 'x', {}, 5])('should return no payments for %p', (value) => {
    expect(storedPayments(value)).toEqual([]);
  });

  it('should drop a row that is malformed', () => {
    expect(
      storedPayments([row, null, { ...row, amount: 5 }, { ...row, paidAt: 'nope' }, 'x']),
    ).toEqual([row]);
  });
});
