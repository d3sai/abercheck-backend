import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { CreateOrderDto } from '../../../../src/modules/orders/dto/create-order.dto';

const validate = (plain: Record<string, unknown>) =>
  validateSync(plainToInstance(CreateOrderDto, plain)).map((error) => error.property);

describe('CreateOrderDto', () => {
  const valid = { orderNumber: ' ЗН-000123 ', clientName: 'Іваненко Іван', amountDue: '1250.50' };

  it('should accept a valid order and trim text fields', () => {
    const dto = plainToInstance(CreateOrderDto, valid);

    expect(validateSync(dto)).toHaveLength(0);
    expect(dto.orderNumber).toBe('ЗН-000123');
  });

  it.each(['100', '100.5', '100.55', '0.01', '999999999999.99'])(
    'should accept amount %s',
    (amountDue) => {
      expect(validate({ ...valid, amountDue })).toEqual([]);
    },
  );

  it.each(['0', '0.00', '-5', '100.555', '1,5', 'abc', '', '1000000000000'])(
    'should reject amount %p',
    (amountDue) => {
      expect(validate({ ...valid, amountDue })).toEqual(['amountDue']);
    },
  );

  it.each([undefined, 'UAH', 'USD'])('should accept currency %p', (currency) => {
    expect(validate({ ...valid, currency })).toEqual([]);
  });

  it.each(['EUR', 'usd', '$'])('should reject currency %p', (currency) => {
    expect(validate({ ...valid, currency })).toEqual(['currency']);
  });

  it.each(['44.9', '44.95', '41.1234'])('should accept exchange rate %s', (exchangeRate) => {
    expect(validate({ ...valid, exchangeRate })).toEqual([]);
  });

  it.each(['0', '44,9', '44.9%', '44.12345', '-1'])(
    'should reject exchange rate %p',
    (exchangeRate) => {
      expect(validate({ ...valid, exchangeRate })).toEqual(['exchangeRate']);
    },
  );

  it('should reject blank required fields', () => {
    expect(validate({ ...valid, orderNumber: '   ', clientName: '' })).toEqual([
      'orderNumber',
      'clientName',
    ]);
  });
});
