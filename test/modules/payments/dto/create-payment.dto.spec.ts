import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { CreatePaymentDto } from '../../../../src/modules/payments/dto/create-payment.dto';

const toDto = (plain: Record<string, unknown>) => plainToInstance(CreatePaymentDto, plain);
const invalidFields = (plain: Record<string, unknown>) =>
  validateSync(toDto(plain)).map((error) => error.property);

describe('CreatePaymentDto', () => {
  const valid = {
    external_transaction_id: 'tx-1',
    order_number: '0000-066717',
    amount: '3614.32',
    payer_name: 'Чернявський Владислав',
    receiving_account: 'ФОП Гук В.С',
    purpose_text: 'Оплата за замовлення №А 0000-066717 від 03.09.2026',
    paid_at: '2026-09-03T15:00:00+03:00',
  };

  it('should accept a valid payment', () => {
    expect(invalidFields(valid)).toEqual([]);
  });

  it.each([null, undefined, '', '   '])('should accept a missing order number %p', (value) => {
    const dto = toDto({ ...valid, order_number: value });

    expect(validateSync(dto)).toHaveLength(0);
    expect(dto.order_number ?? null).toBeNull();
  });

  it.each([undefined, null, 'UAH', 'USD'])('should accept currency %p', (currency) => {
    expect(invalidFields({ ...valid, currency })).toEqual([]);
  });

  it.each(['EUR', 'usd', '$', 1])('should reject currency %p', (currency) => {
    expect(invalidFields({ ...valid, currency })).toEqual(['currency']);
  });

  it('should accept a numeric amount and keep it as a string', () => {
    const dto = toDto({ ...valid, amount: 3614.32 });

    expect(validateSync(dto)).toHaveLength(0);
    expect(dto.amount).toBe('3614.32');
  });

  it.each([0, '0', -10, '10.001', 'abc', null])('should reject amount %p', (amount) => {
    expect(invalidFields({ ...valid, amount })).toEqual(['amount']);
  });

  it.each(['2026-09-03T12:00:00Z', '2026-09-03T15:00+03:00', '2026-09-03T15:00:00.123+03:00'])(
    'should accept paid_at %s',
    (paid_at) => {
      expect(invalidFields({ ...valid, paid_at })).toEqual([]);
    },
  );

  it.each(['2026-09-03T15:00:00', '2026-09-03', '03.09.2026 15:00', '2026-13-03T15:00:00Z'])(
    'should reject paid_at %p',
    (paid_at) => {
      expect(invalidFields({ ...valid, paid_at })).toEqual(['paid_at']);
    },
  );

  it('should require the transaction id, payer and recipient', () => {
    expect(
      invalidFields({
        ...valid,
        external_transaction_id: ' ',
        payer_name: '',
        receiving_account: undefined,
      }),
    ).toEqual(['external_transaction_id', 'payer_name', 'receiving_account']);
  });
});
