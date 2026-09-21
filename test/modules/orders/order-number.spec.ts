import {
  baseNumberOf,
  normalizeBaseNumber,
  normalizeOrderNumber,
  normalizePartNumber,
  partIndexOf,
  partNumber,
} from '../../../src/modules/orders/order-number';

describe('normalizeOrderNumber', () => {
  it.each([
    ['0000-066717', '0000-066717'],
    [' 0000-066717 ', '0000-066717'],
    ['№А 0000-066717', '0000-066717'],
    ['№Д0000-066717', '0000-066717'],
    ['Оплата за замовлення №Т 0000-066717 від 03.09.2026', '0000-066717'],
  ])('should extract the 1C number from %p', (raw, expected) => {
    expect(normalizeOrderNumber(raw)).toBe(expected);
  });

  it.each([
    [' 1548 ', '1548'],
    ['10000-0667171', '10000-0667171'],
  ])('should return a non-standard number %p trimmed', (raw, expected) => {
    expect(normalizeOrderNumber(raw)).toBe(expected);
  });
});

describe('part numbers', () => {
  it.each([
    ['0000-066717', '0000-066717'],
    ['0000-066717(1)', '0000-066717'],
    ['0000-066717(12)', '0000-066717'],
    ['МІНУС-1789996839638', 'МІНУС-1789996839638'],
    ['1548(1)', '1548'],
  ])('should strip the part suffix from %p', (raw, expected) => {
    expect(baseNumberOf(raw)).toBe(expected);
  });

  it.each([
    ['0000-066717(1)', '0000-066717'],
    ['№А 0000-066717 (2)', '0000-066717'],
    [' 0000-066717 ', '0000-066717'],
    ['1548(1)', '1548'],
  ])('should reduce %p typed by a person to the base number', (raw, expected) => {
    expect(normalizeBaseNumber(raw)).toBe(expected);
  });

  it.each([
    ['0000-066717', '0000-066717'],
    ['0000-066717(1)', '0000-066717(1)'],
    ['№А 0000-066717 (2)', '0000-066717(2)'],
    ['Оплата за 0000-066717(3) від 03.09.2026', '0000-066717(3)'],
    ['МІНУС-1789996839638', 'МІНУС-1789996839638'],
  ])('should keep the suffix when %p names one exact order', (raw, expected) => {
    expect(normalizePartNumber(raw)).toBe(expected);
  });

  it('should read the part index, counting the bare number as the first part', () => {
    expect(partIndexOf('0000-066717')).toBe(0);
    expect(partIndexOf('0000-066717(1)')).toBe(1);
    expect(partIndexOf('0000-066717(12)')).toBe(12);
  });

  it('should build part numbers that read back to the same base and index', () => {
    expect(partNumber('0000-066717', 0)).toBe('0000-066717');
    expect(partNumber('0000-066717', 2)).toBe('0000-066717(2)');
    expect(baseNumberOf(partNumber('0000-066717', 2))).toBe('0000-066717');
    expect(partIndexOf(partNumber('0000-066717', 2))).toBe(2);
  });
});
