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

  describe('finance sync', () => {
    const token = 't'.repeat(16);
    const finance = {
      FINANCE_API_URL: 'http://localhost:4100',
      FINANCE_API_TOKEN: token,
      FINANCE_WEBHOOK_TOKEN: token,
    };

    it('should pass when no finance variable is set', () => {
      expect(validateEnv(valid).FINANCE_API_URL).toBeUndefined();
    });

    it('should accept the URL together with both tokens', () => {
      expect(validateEnv({ ...valid, ...finance })).toMatchObject(finance);
    });

    it('should fail when the URL is set without the tokens', () => {
      expect(() => validateEnv({ ...valid, FINANCE_API_URL: finance.FINANCE_API_URL })).toThrow(
        /FINANCE_API_TOKEN[\s\S]*FINANCE_WEBHOOK_TOKEN|FINANCE_WEBHOOK_TOKEN[\s\S]*FINANCE_API_TOKEN/,
      );
    });

    it('should reject a short token and a non-http URL', () => {
      expect(() => validateEnv({ ...valid, ...finance, FINANCE_API_TOKEN: 'short' })).toThrow(
        /FINANCE_API_TOKEN/,
      );
      expect(() => validateEnv({ ...valid, ...finance, FINANCE_API_URL: 'ftp://x' })).toThrow(
        /FINANCE_API_URL/,
      );
    });

    it('should treat blank finance variables as unset', () => {
      expect(
        validateEnv({ ...valid, FINANCE_API_URL: '', FINANCE_API_TOKEN: '' }).FINANCE_API_URL,
      ).toBeUndefined();
    });
  });

  describe('forum topics', () => {
    it('should parse topic ids as numbers and leave them optional', () => {
      expect(validateEnv(valid).TELEGRAM_TOPIC_REQUESTS_ID).toBeUndefined();
      expect(
        validateEnv({ ...valid, TELEGRAM_TOPIC_REQUESTS_ID: '12', TELEGRAM_TOPIC_PAYMENTS_ID: '' }),
      ).toMatchObject({ TELEGRAM_TOPIC_REQUESTS_ID: 12, TELEGRAM_TOPIC_PAYMENTS_ID: undefined });
    });

    it.each(['0', '-3', 'abc', '1.5'])('should reject topic id %p', (value) => {
      expect(() => validateEnv({ ...valid, TELEGRAM_TOPIC_REPORTS_ID: value })).toThrow(
        /TELEGRAM_TOPIC_REPORTS_ID/,
      );
    });
  });
});
