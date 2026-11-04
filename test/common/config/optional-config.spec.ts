import { optionalNonBlank, optionalPositiveInt } from '../../../src/common/config/optional-config';

const reader = (value: unknown) => ({ get: () => value });

describe('optionalNonBlank', () => {
  it.each([undefined, null, '', '   ', 5])('should return undefined for %p', (value) => {
    expect(optionalNonBlank(reader(value), 'K')).toBeUndefined();
  });

  it('should return the trimmed string', () => {
    expect(optionalNonBlank(reader(' http://x '), 'K')).toBe('http://x');
  });
});

describe('optionalPositiveInt', () => {
  it.each([undefined, null, '', '  ', '0', '-3', '1.5', 'abc', '12abc', 0, -1, 2.5, NaN, {}])(
    'should return undefined for %p',
    (value) => {
      expect(optionalPositiveInt(reader(value), 'K')).toBeUndefined();
    },
  );

  it.each([
    ['12', 12],
    [' 7 ', 7],
    [9, 9],
  ])('should accept %p', (value, expected) => {
    expect(optionalPositiveInt(reader(value), 'K')).toBe(expected);
  });
});
