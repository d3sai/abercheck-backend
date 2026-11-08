import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import { AuthService, JWT_AUDIENCE, JWT_ISSUER } from '../../../src/modules/auth/auth.service';
import { hashPassword } from '../../../src/modules/auth/password-hasher';
import { TelegramLoginVerifier } from '../../../src/modules/auth/telegram-login.verifier';
import { ApiError } from '../../../src/common/api-error';
import { ManagerRole, ManagerStatus, Prisma } from '../../../src/generated/prisma/client';
import { PrismaService } from '../../../src/common/prisma/prisma.service';

async function failure(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ApiError) {
      return (error.getResponse() as { code: string }).code;
    }
    throw error;
  }
  throw new Error('Expected the call to fail');
}

describe('AuthService', () => {
  const manager = {
    findUnique: jest.fn(),
    upsert: jest.fn(),
    update: jest.fn(),
    count: jest.fn(),
  };
  const telegram = { verify: jest.fn() };
  const config = { get: jest.fn() };
  const jwt = new JwtService({
    secret: 's'.repeat(32),
    signOptions: { expiresIn: 60, issuer: JWT_ISSUER, audience: JWT_AUDIENCE },
    verifyOptions: { issuer: JWT_ISSUER, audience: JWT_AUDIENCE },
  });
  const active = {
    id: 7,
    telegramId: 5000000000n,
    name: 'Христина',
    username: 'khrystyna',
    status: ManagerStatus.ACTIVE,
    role: ManagerRole.MANAGER,
    login: null,
    passwordHash: null,
    sessionVersion: 0,
    createdAt: new Date('2026-09-01T00:00:00Z'),
  };
  const telegramLogin = {
    id: 5000000000,
    first_name: 'Христина',
    auth_date: 1_789_000_000,
    hash: 'a'.repeat(64),
  };
  let passwordHash: string;
  let service: AuthService;

  beforeAll(async () => {
    passwordHash = await hashPassword('secret-pass');
  });

  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [
        AuthService,
        { provide: PrismaService, useValue: { manager } },
        { provide: JwtService, useValue: jwt },
        { provide: TelegramLoginVerifier, useValue: telegram },
        { provide: ConfigService, useValue: config },
      ],
    }).compile();

    service = moduleRef.get(AuthService);
    telegram.verify.mockResolvedValue(true);
  });

  afterEach(() => jest.resetAllMocks());

  describe('loginWithTelegram', () => {
    it('should reject a payload with a bad signature before touching the database', async () => {
      telegram.verify.mockResolvedValue(false);

      await expect(failure(service.loginWithTelegram(telegramLogin))).resolves.toBe(
        'TELEGRAM_AUTH_INVALID',
      );
      expect(manager.findUnique).not.toHaveBeenCalled();
    });

    it('should refuse a Telegram user the bot has never seen', async () => {
      manager.findUnique.mockResolvedValue(null);

      await expect(failure(service.loginWithTelegram(telegramLogin))).resolves.toBe(
        'NOT_REGISTERED',
      );
    });

    it.each([
      [ManagerStatus.PENDING, 'ACCESS_PENDING'],
      [ManagerStatus.REJECTED, 'ACCESS_REJECTED'],
    ])('should refuse a %s manager', async (status, code) => {
      manager.findUnique.mockResolvedValue({ ...active, status });

      await expect(failure(service.loginWithTelegram(telegramLogin))).resolves.toBe(code);
    });

    it('should open a session for an active manager', async () => {
      manager.findUnique.mockResolvedValue(active);

      const session = await service.loginWithTelegram(telegramLogin);

      expect(manager.findUnique).toHaveBeenCalledWith({ where: { telegramId: 5000000000n } });
      expect(session.manager).toEqual({
        id: 7,
        name: 'Христина',
        username: 'khrystyna',
        telegramId: '5000000000',
        role: ManagerRole.MANAGER,
        login: null,
        hasPassword: false,
      });
      await expect(service.authenticate(session.token)).resolves.toBe(active);
    });

    it('should make the very first manager the bot ever sees an active admin', async () => {
      const admin = { ...active, telegramId: 111n, role: ManagerRole.ADMIN };
      manager.findUnique.mockResolvedValue(null);
      manager.count.mockResolvedValue(0);
      manager.upsert.mockResolvedValue(admin);

      const session = await service.loginWithTelegram({
        ...telegramLogin,
        id: 111,
        first_name: 'Уляна',
        last_name: 'Адмін',
      });

      expect(manager.count).toHaveBeenCalledWith({ where: { telegramId: { not: 111n } } });
      expect(manager.upsert).toHaveBeenCalledWith({
        where: { telegramId: 111n },
        create: {
          telegramId: 111n,
          name: 'Уляна Адмін',
          username: null,
          status: ManagerStatus.ACTIVE,
          role: ManagerRole.ADMIN,
        },
        update: { status: ManagerStatus.ACTIVE, role: ManagerRole.ADMIN },
      });
      expect(session.manager.role).toBe(ManagerRole.ADMIN);
    });

    it('should promote its own pending request when nobody else has registered yet', async () => {
      manager.findUnique.mockResolvedValue({
        ...active,
        telegramId: 111n,
        status: ManagerStatus.PENDING,
        role: ManagerRole.MANAGER,
      });
      manager.count.mockResolvedValue(0);
      manager.upsert.mockResolvedValue({ ...active, telegramId: 111n, role: ManagerRole.ADMIN });

      await service.loginWithTelegram({ ...telegramLogin, id: 111 });

      expect(manager.count).toHaveBeenCalledWith({ where: { telegramId: { not: 111n } } });
      expect(manager.upsert).toHaveBeenCalled();
    });

    it('should not bootstrap a second manager once someone else is already registered', async () => {
      manager.findUnique.mockResolvedValue({
        ...active,
        telegramId: 111n,
        status: ManagerStatus.PENDING,
      });
      manager.count.mockResolvedValue(1);

      await expect(failure(service.loginWithTelegram({ ...telegramLogin, id: 111 }))).resolves.toBe(
        'ACCESS_PENDING',
      );
      expect(manager.upsert).not.toHaveBeenCalled();
    });

    it('should bootstrap only the configured Telegram id when one is set', async () => {
      config.get.mockReturnValue(222);
      manager.findUnique.mockResolvedValue(null);
      manager.count.mockResolvedValue(0);

      await expect(failure(service.loginWithTelegram({ ...telegramLogin, id: 111 }))).resolves.toBe(
        'NOT_REGISTERED',
      );
      expect(manager.upsert).not.toHaveBeenCalled();
    });

    it('should bootstrap the configured Telegram id into an admin', async () => {
      config.get.mockReturnValue(111);
      manager.findUnique.mockResolvedValue(null);
      manager.count.mockResolvedValue(0);
      manager.upsert.mockResolvedValue({ ...active, telegramId: 111n, role: ManagerRole.ADMIN });

      await service.loginWithTelegram({ ...telegramLogin, id: 111 });

      expect(manager.upsert).toHaveBeenCalled();
    });

    it('should not undo a rejection even if no one else is registered', async () => {
      manager.findUnique.mockResolvedValue({
        ...active,
        telegramId: 111n,
        status: ManagerStatus.REJECTED,
      });

      await expect(failure(service.loginWithTelegram({ ...telegramLogin, id: 111 }))).resolves.toBe(
        'ACCESS_REJECTED',
      );
      expect(manager.count).not.toHaveBeenCalled();
      expect(manager.upsert).not.toHaveBeenCalled();
    });
  });

  it('should end every session of a manager at once', async () => {
    await service.revokeSessions(7);

    expect(manager.update).toHaveBeenCalledWith({
      where: { id: 7 },
      data: { sessionVersion: { increment: 1 } },
    });
  });

  describe('loginWithPassword', () => {
    it('should reject an unknown login', async () => {
      manager.findUnique.mockResolvedValue(null);

      await expect(
        failure(service.loginWithPassword({ login: 'nobody', password: 'secret-pass' })),
      ).resolves.toBe('INVALID_CREDENTIALS');
    });

    it('should reject a wrong password', async () => {
      manager.findUnique.mockResolvedValue({ ...active, login: 'khrystyna', passwordHash });

      await expect(
        failure(service.loginWithPassword({ login: 'khrystyna', password: 'wrong-pass' })),
      ).resolves.toBe('INVALID_CREDENTIALS');
    });

    it('should open a session for the right password', async () => {
      manager.findUnique.mockResolvedValue({ ...active, login: 'khrystyna', passwordHash });

      const session = await service.loginWithPassword({
        login: 'khrystyna',
        password: 'secret-pass',
      });

      expect(manager.findUnique).toHaveBeenCalledWith({ where: { login: 'khrystyna' } });
      expect(session.manager).toMatchObject({ login: 'khrystyna', hasPassword: true });
    });

    it('should not let a manager in whose access was revoked', async () => {
      manager.findUnique.mockResolvedValue({
        ...active,
        status: ManagerStatus.REJECTED,
        passwordHash,
      });

      await expect(
        failure(service.loginWithPassword({ login: 'khrystyna', password: 'secret-pass' })),
      ).resolves.toBe('ACCESS_REJECTED');
    });
  });

  describe('setCredentials', () => {
    const credentials = { login: 'khrystyna', password: 'new-secret-pass' };

    it('should store a hashed password and invalidate older sessions', async () => {
      manager.update.mockResolvedValue({ ...active, login: 'khrystyna', sessionVersion: 1 });

      const session = await service.setCredentials(active, credentials);

      expect(manager.update).toHaveBeenCalledWith({
        where: { id: 7 },
        data: {
          login: 'khrystyna',
          passwordHash: expect.stringMatching(/^scrypt\$/) as unknown,
          sessionVersion: { increment: 1 },
        },
      });
      manager.findUnique.mockResolvedValue({ ...active, sessionVersion: 1 });
      await expect(service.authenticate(session.token)).resolves.toMatchObject({ id: 7 });
    });

    it('should require the current password to replace an existing one', async () => {
      await expect(
        failure(service.setCredentials({ ...active, passwordHash }, credentials)),
      ).resolves.toBe('CURRENT_PASSWORD_INVALID');
      expect(manager.update).not.toHaveBeenCalled();
    });

    it('should replace the password when the current one is confirmed', async () => {
      manager.update.mockResolvedValue({ ...active, sessionVersion: 1 });

      await service.setCredentials(
        { ...active, passwordHash },
        { ...credentials, currentPassword: 'secret-pass' },
      );

      expect(manager.update).toHaveBeenCalled();
    });

    it('should report a login that is already taken', async () => {
      manager.update.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('taken', { code: 'P2002', clientVersion: 'test' }),
      );

      await expect(failure(service.setCredentials(active, credentials))).resolves.toBe(
        'LOGIN_TAKEN',
      );
    });
  });

  describe('authenticate', () => {
    it('should ignore a token that was not signed by us', async () => {
      await expect(service.authenticate('not-a-token')).resolves.toBeNull();
      expect(manager.findUnique).not.toHaveBeenCalled();
    });

    it('should reject a token issued before the password was changed', async () => {
      const token = await jwt.signAsync({ sub: '7', ver: 0 });
      manager.findUnique.mockResolvedValue({ ...active, sessionVersion: 1 });

      await expect(service.authenticate(token)).resolves.toBeNull();
    });

    it('should reject a token of a manager whose access was revoked', async () => {
      const token = await jwt.signAsync({ sub: '7', ver: 0 });
      manager.findUnique.mockResolvedValue({ ...active, status: ManagerStatus.REJECTED });

      await expect(service.authenticate(token)).resolves.toBeNull();
    });
  });
});
