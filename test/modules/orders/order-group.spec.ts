import { OrderStatus, Prisma } from '../../../src/generated/prisma/client';
import {
  allocateShares,
  liveParts,
  nextPartIndex,
  pickAnchor,
  rollUp,
  summarizeGroup,
} from '../../../src/modules/orders/order-group';

const d = (value: string) => new Prisma.Decimal(value);

const part = (
  id: number,
  amountDue: string,
  status: OrderStatus = OrderStatus.AWAITING_PAYMENT,
  overrides: Record<string, unknown> = {},
) => ({
  id,
  orderNumber: id === 1 ? '0000-066717' : `0000-066717(${id - 1})`,
  baseNumber: '0000-066717',
  clientName: `ФОП ${id}`,
  amountDue: d(amountDue),
  status,
  ...overrides,
});

describe('order group', () => {
  describe('summarizeGroup', () => {
    it('should add up what is due and judge the status of the number as a whole', () => {
      const parts = [part(1, '700'), part(2, '300')];

      expect(summarizeGroup(parts, d('0'))).toMatchObject({ status: OrderStatus.AWAITING_PAYMENT });
      expect(summarizeGroup(parts, d('999.99'))).toMatchObject({
        status: OrderStatus.PARTIALLY_PAID,
      });
      expect(summarizeGroup(parts, d('1000'))).toMatchObject({
        due: d('1000'),
        status: OrderStatus.PAID,
      });
      expect(summarizeGroup(parts, d('1000.01'))).toMatchObject({ status: OrderStatus.OVERPAID });
    });

    it('should leave cancelled parts out of what is due', () => {
      const parts = [part(1, '700', OrderStatus.CANCELLED), part(2, '300')];

      expect(summarizeGroup(parts, d('300'))).toMatchObject({
        due: d('300'),
        status: OrderStatus.PAID,
      });
    });

    it('should call a number cancelled only when every part is', () => {
      const parts = [part(1, '700', OrderStatus.CANCELLED), part(2, '300', OrderStatus.CANCELLED)];

      expect(summarizeGroup(parts, d('0'))).toMatchObject({
        due: d('0'),
        status: OrderStatus.CANCELLED,
      });
    });
  });

  describe('allocateShares', () => {
    const shares = (parts: ReturnType<typeof part>[], paid: string) =>
      Object.fromEntries(
        [...allocateShares(parts, d(paid))].map(([id, share]) => [id, share.toFixed(2)]),
      );

    it('should fill the parts one after another', () => {
      const parts = [part(1, '700'), part(2, '300'), part(3, '100')];

      expect(shares(parts, '0')).toEqual({ 1: '0.00', 2: '0.00', 3: '0.00' });
      expect(shares(parts, '500')).toEqual({ 1: '500.00', 2: '0.00', 3: '0.00' });
      expect(shares(parts, '800')).toEqual({ 1: '700.00', 2: '100.00', 3: '0.00' });
      expect(shares(parts, '1100')).toEqual({ 1: '700.00', 2: '300.00', 3: '100.00' });
    });

    it('should put an overpayment on the last live part', () => {
      const parts = [part(1, '700'), part(2, '300')];

      expect(shares(parts, '1150')).toEqual({ 1: '700.00', 2: '450.00' });
    });

    it('should never hand a share to a cancelled part', () => {
      const parts = [part(1, '700', OrderStatus.CANCELLED), part(2, '300')];

      expect(shares(parts, '300')).toEqual({ 1: '0.00', 2: '300.00' });
    });

    it('should treat a negative pool as nothing paid', () => {
      expect(shares([part(1, '100')], '-5')).toEqual({ 1: '0.00' });
    });

    it('should always hand out exactly what was paid when a live part exists', () => {
      const parts = [part(1, '100.10'), part(2, '200.20'), part(3, '50.05')];

      for (const paid of ['0', '0.01', '100.10', '250', '350.35', '1000']) {
        const total = [...allocateShares(parts, d(paid)).values()].reduce(
          (sum, share) => sum.plus(share),
          d('0'),
        );
        expect(total.toFixed(2)).toBe(d(paid).toFixed(2));
      }
    });
  });

  describe('pickAnchor', () => {
    it('should pick the first part that is still alive', () => {
      const parts = [part(1, '10', OrderStatus.CANCELLED), part(2, '10'), part(3, '10')];

      expect(pickAnchor(parts).id).toBe(2);
    });

    it('should fall back to the first part when all are cancelled', () => {
      const parts = [part(1, '10', OrderStatus.CANCELLED), part(2, '10', OrderStatus.CANCELLED)];

      expect(pickAnchor(parts).id).toBe(1);
    });

    it('should refuse an empty group', () => {
      expect(() => pickAnchor([])).toThrow('no parts');
    });
  });

  describe('liveParts', () => {
    it('should drop cancelled parts', () => {
      expect(
        liveParts([part(1, '1', OrderStatus.CANCELLED), part(2, '1')]).map((p) => p.id),
      ).toEqual([2]);
    });
  });

  describe('nextPartIndex', () => {
    it('should start at the bare number for a new group', () => {
      expect(nextPartIndex([])).toBe(0);
    });

    it('should continue after the highest suffix, never reusing a number', () => {
      expect(nextPartIndex([{ orderNumber: '0000-066717' }])).toBe(1);
      expect(
        nextPartIndex([{ orderNumber: '0000-066717' }, { orderNumber: '0000-066717(1)' }]),
      ).toBe(2);
      expect(
        nextPartIndex([{ orderNumber: '0000-066717' }, { orderNumber: '0000-066717(4)' }]),
      ).toBe(5);
    });
  });

  describe('rollUp', () => {
    const full = (id: number, amountDue: string, status: OrderStatus, clientName: string) =>
      ({ ...part(id, amountDue, status), clientName, managerId: 7 }) as ReturnType<typeof part> & {
        managerId: number;
      };

    it('should stand for the whole number: base number, total due, every client once', () => {
      const parts = [
        full(1, '700', OrderStatus.PAID, 'Перший'),
        full(2, '300', OrderStatus.PAID, 'Другий'),
        full(3, '50', OrderStatus.PAID, 'Перший'),
      ] as never[];

      expect(rollUp(parts)).toMatchObject({
        id: 1,
        orderNumber: '0000-066717',
        clientName: 'Перший, Другий',
        amountDue: d('1050'),
        managerId: 7,
      });
    });

    it('should skip cancelled parts, but still describe a fully cancelled number', () => {
      const someCancelled = [
        full(1, '700', OrderStatus.CANCELLED, 'Скасований'),
        full(2, '300', OrderStatus.AWAITING_PAYMENT, 'Живий'),
      ] as never[];
      const allCancelled = [
        full(1, '700', OrderStatus.CANCELLED, 'Скасований'),
        full(2, '300', OrderStatus.CANCELLED, 'Теж'),
      ] as never[];

      expect(rollUp(someCancelled)).toMatchObject({
        id: 2,
        clientName: 'Живий',
        amountDue: d('300'),
      });
      expect(rollUp(allCancelled)).toMatchObject({
        id: 1,
        clientName: 'Скасований, Теж',
        amountDue: d('1000'),
        status: OrderStatus.CANCELLED,
      });
    });
  });
});
