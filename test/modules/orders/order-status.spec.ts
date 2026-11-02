import { OrderStatus, Prisma } from '../../../src/generated/prisma/client';
import { calculateOrderStatus } from '../../../src/modules/orders/order-status';

const d = (value: string) => new Prisma.Decimal(value);

describe('calculateOrderStatus', () => {
  const due = d('6158.41');

  it.each([
    ['0', OrderStatus.AWAITING_PAYMENT],
    ['3614.32', OrderStatus.PARTIALLY_PAID],
    ['6158.41', OrderStatus.PAID],
    ['6158.40', OrderStatus.PAID],
    ['6158.42', OrderStatus.PAID],
    ['6096.83', OrderStatus.PAID],
    ['6096.82', OrderStatus.PARTIALLY_PAID],
    ['6219.99', OrderStatus.PAID],
    ['6220.00', OrderStatus.OVERPAID],
    ['6208.41', OrderStatus.PAID],
    ['6658.41', OrderStatus.OVERPAID],
  ])('should return %s paid → %s', (paid, expected) => {
    expect(calculateOrderStatus(due, d(paid), OrderStatus.AWAITING_PAYMENT)).toBe(expected);
  });

  it('should treat a split payment to two recipients as paid in full', () => {
    const paid = d('3614.32').plus(d('2544.09'));

    expect(calculateOrderStatus(due, paid, OrderStatus.PARTIALLY_PAID)).toBe(OrderStatus.PAID);
  });

  it('should move an underpaid order back to partial when a top-up is still short', () => {
    expect(calculateOrderStatus(due, d('5000'), OrderStatus.UNDERPAID)).toBe(
      OrderStatus.PARTIALLY_PAID,
    );
  });

  it('should keep a cancelled order cancelled', () => {
    expect(calculateOrderStatus(due, due, OrderStatus.CANCELLED)).toBe(OrderStatus.CANCELLED);
  });
});
