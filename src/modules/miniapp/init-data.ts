import { createHmac, timingSafeEqual } from 'node:crypto';

export type InitDataResult =
  | { ok: true; telegramId: bigint; authDate: Date }
  | { ok: false; reason: 'malformed' | 'bad-hash' | 'expired' | 'no-user' };

const fail = (reason: 'malformed' | 'bad-hash' | 'expired' | 'no-user'): InitDataResult => ({
  ok: false,
  reason,
});

/** Verifies Telegram Web App initData: https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app */
export function verifyInitData(
  raw: string,
  botToken: string,
  now: Date,
  maxAgeSeconds = 86_400,
): InitDataResult {
  const params = new URLSearchParams(raw);
  const hash = params.get('hash');
  const authDate = Number(params.get('auth_date'));
  if (!hash || !params.get('auth_date') || !Number.isInteger(authDate)) {
    return fail('malformed');
  }

  params.delete('hash');
  const checkString = [...params.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');
  const secret = createHmac('sha256', 'WebAppData').update(botToken).digest();
  const expected = createHmac('sha256', secret).update(checkString).digest();
  const provided = Buffer.from(hash, 'hex');
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
    return fail('bad-hash');
  }

  if (now.getTime() / 1000 - authDate > maxAgeSeconds) {
    return fail('expired');
  }

  const telegramId = parseUserId(params.get('user'));
  if (telegramId === null) {
    return fail('no-user');
  }
  return { ok: true, telegramId, authDate: new Date(authDate * 1000) };
}

function parseUserId(user: string | null): bigint | null {
  if (!user) {
    return null;
  }
  try {
    const id: unknown = (JSON.parse(user) as { id?: unknown } | null)?.id;
    return typeof id === 'number' && Number.isSafeInteger(id) ? BigInt(id) : null;
  } catch {
    return null;
  }
}
