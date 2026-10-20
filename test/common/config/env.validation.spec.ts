import { listenTarget, NodeEnv, validateEnv } from '../../../src/common/config/env.validation';

describe('validateEnv', () => {
  const valid = {
    DATABASE_URL: 'postgresql://user:pass@db.example.com:5432/app?schema=public',
    EXTERNAL_API_KEY: 'k'.repeat(32),
    TELEGRAM_BOT_TOKEN: `123456789:${'A'.repeat(35)}`,
    TELEGRAM_ADMIN_CHAT_ID: '-1002286861249',
    WEB_JWT_SECRET: 's'.repeat(32),
  };

  it('should apply defaults', () => {
    expect(validateEnv(valid)).toMatchObject({ NODE_ENV: NodeEnv.Development, PORT: '3000' });
  });

  it('should accept a missing ADMIN_API_KEY and a 32-char one', () => {
    expect(validateEnv(valid).ADMIN_API_KEY).toBeUndefined();
    expect(validateEnv({ ...valid, ADMIN_API_KEY: 'a'.repeat(32) }).ADMIN_API_KEY).toBe(
      'a'.repeat(32),
    );
  });

  it('should reject a short ADMIN_API_KEY', () => {
    expect(() => validateEnv({ ...valid, ADMIN_API_KEY: 'a'.repeat(10) })).toThrow(/ADMIN_API_KEY/);
  });

  it('should listen on a TCP port bound to the host given by the hosting', () => {
    const env = validateEnv({ ...valid, PORT: '3000', HOST: '127.12.34.56' });

    expect(listenTarget(env)).toEqual([3000, '127.12.34.56']);
  });

  it('should listen on a unix socket when PORT is a path and HOST is empty', () => {
    const socket = '/home/user/.system/nodejs/bot.example.com.sock';
    const env = validateEnv({ ...valid, PORT: socket, HOST: '' });

    expect(env.HOST).toBeUndefined();
    expect(listenTarget(env)).toEqual([socket]);
  });

  it.each(['0', 'abc', 'relative/path.sock', '3000 '])('should reject PORT %p', (PORT) => {
    expect(() => validateEnv({ ...valid, PORT })).toThrow(/PORT/);
  });

  it('should fail fast when DATABASE_URL is missing', () => {
    expect(() => validateEnv({ EXTERNAL_API_KEY: valid.EXTERNAL_API_KEY })).toThrow(/DATABASE_URL/);
  });

  it('should reject a non-PostgreSQL connection string', () => {
    expect(() => validateEnv({ ...valid, DATABASE_URL: 'mysql://localhost/app' })).toThrow(
      /DATABASE_URL/,
    );
  });

  it('should parse the admin chat id as a negative number', () => {
    expect(validateEnv(valid).TELEGRAM_ADMIN_CHAT_ID).toBe(-1002286861249);
  });

  it('should reject a malformed bot token', () => {
    expect(() => validateEnv({ ...valid, TELEGRAM_BOT_TOKEN: 'not-a-token' })).toThrow(
      /TELEGRAM_BOT_TOKEN/,
    );
  });

  it('should reject a short EXTERNAL_API_KEY', () => {
    expect(() => validateEnv({ ...valid, EXTERNAL_API_KEY: 'short' })).toThrow(/EXTERNAL_API_KEY/);
  });

  it('should reject a short WEB_JWT_SECRET', () => {
    expect(() => validateEnv({ ...valid, WEB_JWT_SECRET: 'short' })).toThrow(/WEB_JWT_SECRET/);
  });
});
