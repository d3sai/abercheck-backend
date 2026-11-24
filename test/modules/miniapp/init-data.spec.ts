import { createHmac } from 'node:crypto';
import { verifyInitData } from '../../../src/modules/miniapp/init-data';

const TOKEN = '123456:TEST-token';
const NOW = new Date('2026-11-04T12:00:00Z');
const seconds = (date: Date) => Math.floor(date.getTime() / 1000);

function sign(fields: Record<string, string>, token = TOKEN): string {
  const check = Object.entries(fields)
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');
  const secret = createHmac('sha256', 'WebAppData').update(token).digest();
  const hash = createHmac('sha256', secret).update(check).digest('hex');
  return new URLSearchParams({ ...fields, hash }).toString();
}

const user = JSON.stringify({ id: 777000111, first_name: 'Іван', username: 'ivan' });
const fresh = (): Record<string, string> => ({
  auth_date: String(seconds(NOW) - 60),
  query_id: 'AAH',
  signature: 'sig_abc-123',
  user,
});

describe('verifyInitData', () => {
  it('should accept valid data and return the telegram id and auth date', () => {
    const result = verifyInitData(sign(fresh()), TOKEN, NOW);

    expect(result).toEqual({
      ok: true,
      telegramId: 777000111n,
      authDate: new Date((seconds(NOW) - 60) * 1000),
    });
  });

  it('should reject data signed with another bot token', () => {
    expect(verifyInitData(sign(fresh(), 'other:token'), TOKEN, NOW)).toEqual({
      ok: false,
      reason: 'bad-hash',
    });
  });

  it('should reject data with one changed character', () => {
    const raw = sign(fresh()).replace('query_id=AAH', 'query_id=AAI');

    expect(verifyInitData(raw, TOKEN, NOW)).toEqual({ ok: false, reason: 'bad-hash' });
  });

  it('should reject a hash of the wrong length without throwing', () => {
    const raw = sign(fresh()).replace(/hash=[0-9a-f]+/, 'hash=abcd');

    expect(verifyInitData(raw, TOKEN, NOW)).toEqual({ ok: false, reason: 'bad-hash' });
  });

  it('should reject auth_date older than 24 hours', () => {
    const old = { ...fresh(), auth_date: String(seconds(NOW) - 25 * 3600) };

    expect(verifyInitData(sign(old), TOKEN, NOW)).toEqual({ ok: false, reason: 'expired' });
  });

  it('should honour a custom max age', () => {
    expect(verifyInitData(sign(fresh()), TOKEN, NOW, 30)).toEqual({ ok: false, reason: 'expired' });
  });

  it('should reject validly signed data without a user', () => {
    const rest = fresh();
    delete rest.user;

    expect(verifyInitData(sign(rest), TOKEN, NOW)).toEqual({ ok: false, reason: 'no-user' });
  });

  it('should reject a user that is not JSON with a numeric id', () => {
    expect(verifyInitData(sign({ ...fresh(), user: '{nope' }), TOKEN, NOW)).toEqual({
      ok: false,
      reason: 'no-user',
    });
    expect(verifyInitData(sign({ ...fresh(), user: '{"id":"x"}' }), TOKEN, NOW)).toEqual({
      ok: false,
      reason: 'no-user',
    });
  });

  it.each(['', 'garbage', 'auth_date=1&user=%7B%7D', 'hash=abc'])(
    'should report %p as malformed',
    (raw) => {
      expect(verifyInitData(raw, TOKEN, NOW)).toEqual({ ok: false, reason: 'malformed' });
    },
  );

  it('should report a missing auth_date as malformed', () => {
    const rest = fresh();
    delete rest.auth_date;

    expect(verifyInitData(sign(rest), TOKEN, NOW)).toEqual({ ok: false, reason: 'malformed' });
  });
});
