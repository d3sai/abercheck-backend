import {
  kyivDate,
  kyivDateTime,
  kyivDayStart,
  kyivDayStartOf,
  nextKyivDayStart,
  previousKyivDayStart,
} from '../../src/common/kyiv-time';

const iso = (date: Date) => date.toISOString();

describe('Kyiv day boundaries', () => {
  it('should find midnight in summer time (UTC+3)', () => {
    expect(iso(kyivDayStart(new Date('2026-09-11T15:00:00Z')))).toBe('2026-09-10T21:00:00.000Z');
  });

  it('should find midnight in winter time (UTC+2)', () => {
    expect(iso(kyivDayStart(new Date('2026-12-15T10:00:00Z')))).toBe('2026-12-14T22:00:00.000Z');
  });

  it('should treat the late evening UTC as the next Kyiv day', () => {
    expect(iso(kyivDayStart(new Date('2026-09-10T21:30:00Z')))).toBe('2026-09-10T21:00:00.000Z');
  });

  it('should step over the spring DST change (23-hour day)', () => {
    const march29 = kyivDayStart(new Date('2026-03-29T12:00:00Z'));

    expect(iso(march29)).toBe('2026-03-28T22:00:00.000Z');
    expect(iso(nextKyivDayStart(march29))).toBe('2026-03-29T21:00:00.000Z');
  });

  it('should step over the autumn DST change (25-hour day)', () => {
    const october25 = kyivDayStart(new Date('2026-10-25T12:00:00Z'));

    expect(iso(october25)).toBe('2026-10-24T21:00:00.000Z');
    expect(iso(nextKyivDayStart(october25))).toBe('2026-10-25T22:00:00.000Z');
    expect(iso(previousKyivDayStart(nextKyivDayStart(october25)))).toBe(iso(october25));
  });

  it('should name the Kyiv calendar date of an instant', () => {
    expect(kyivDate(new Date('2026-09-10T21:30:00Z'))).toBe('2026-09-11');
    expect(kyivDate(new Date('2026-09-10T20:59:00Z'))).toBe('2026-09-10');
  });

  it('should find the start of a day given as YYYY-MM-DD', () => {
    expect(iso(kyivDayStartOf('2026-09-11'))).toBe('2026-09-10T21:00:00.000Z');
    expect(iso(kyivDayStartOf('2026-12-15'))).toBe('2026-12-14T22:00:00.000Z');
  });
});

describe('kyivDateTime', () => {
  it('should convert a Kyiv wall-clock time in summer (UTC+3)', () => {
    expect(iso(kyivDateTime(2026, 9, 7, 14, 57))).toBe('2026-09-07T11:57:00.000Z');
  });

  it('should convert a Kyiv wall-clock time in winter (UTC+2)', () => {
    expect(iso(kyivDateTime(2026, 12, 15, 10, 0))).toBe('2026-12-15T08:00:00.000Z');
  });

  it('should default the time of day to midnight', () => {
    expect(iso(kyivDateTime(2026, 9, 7))).toBe('2026-09-06T21:00:00.000Z');
  });

  it('should round-trip through kyivParts for an ordinary date', () => {
    const date = kyivDateTime(2026, 9, 7, 14, 57);

    expect(kyivDate(date)).toBe('2026-09-07');
  });
});
