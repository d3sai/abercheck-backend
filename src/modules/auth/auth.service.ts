import { Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { randomBytes } from 'node:crypto';
import { type Manager, ManagerRole, ManagerStatus } from '../../generated/prisma/client';
import { isUniqueViolation } from '../../common/prisma/prisma-errors';
import { PrismaService } from '../../common/prisma/prisma.service';
import { AuthErrors } from './auth.errors';
import type { LoginDto } from './dto/login.dto';
import { type SessionResponse, toMeResponse } from './dto/session.response';
import type { SetCredentialsDto } from './dto/set-credentials.dto';
import type { TelegramLoginDto } from './dto/telegram-login.dto';
import { hashPassword, verifyPassword } from './password-hasher';
import { TelegramLoginVerifier } from './telegram-login.verifier';

export const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;
export const JWT_ISSUER = 'abercheck';
export const JWT_AUDIENCE = 'abercheck-cabinet';

interface SessionPayload {
  sub: string;
  ver: number;
}

let timingDummy: Promise<string> | undefined;
const dummyHash = () => (timingDummy ??= hashPassword(randomBytes(16).toString('hex')));

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly telegram: TelegramLoginVerifier,
  ) {}

  async loginWithTelegram(data: TelegramLoginDto): Promise<SessionResponse> {
    if (!(await this.telegram.verify(data))) {
      throw AuthErrors.invalidTelegramLogin();
    }
    const telegramId = BigInt(data.id);
    const existing = await this.prisma.manager.findUnique({ where: { telegramId } });
    const manager = (await this.bootstrapsAdmin(telegramId, existing))
      ? await this.prisma.manager.upsert({
          where: { telegramId },
          create: {
            telegramId,
            name: [data.first_name, data.last_name].filter(Boolean).join(' '),
            username: data.username ?? null,
            status: ManagerStatus.ACTIVE,
            role: ManagerRole.ADMIN,
          },
          update: { status: ManagerStatus.ACTIVE, role: ManagerRole.ADMIN },
        })
      : existing;
    return this.issue(this.ensureActive(manager));
  }

  async revokeSessions(managerId: number): Promise<void> {
    await this.prisma.manager.update({
      where: { id: managerId },
      data: { sessionVersion: { increment: 1 } },
    });
  }

  async loginWithPassword({ login, password }: LoginDto): Promise<SessionResponse> {
    const manager = await this.prisma.manager.findUnique({ where: { login } });
    const valid = await verifyPassword(password, manager?.passwordHash ?? (await dummyHash()));
    if (!manager?.passwordHash || !valid) {
      throw AuthErrors.invalidCredentials();
    }
    return this.issue(this.ensureActive(manager));
  }

  async setCredentials(manager: Manager, dto: SetCredentialsDto): Promise<SessionResponse> {
    if (manager.passwordHash) {
      const confirmed =
        dto.currentPassword !== undefined &&
        (await verifyPassword(dto.currentPassword, manager.passwordHash));
      if (!confirmed) {
        throw AuthErrors.currentPasswordInvalid();
      }
    }

    try {
      const updated = await this.prisma.manager.update({
        where: { id: manager.id },
        data: {
          login: dto.login,
          passwordHash: await hashPassword(dto.password),
          sessionVersion: { increment: 1 },
        },
      });
      return await this.issue(updated);
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw AuthErrors.loginTaken();
      }
      throw error;
    }
  }

  async authenticate(token: string): Promise<Manager | null> {
    let payload: SessionPayload;
    try {
      payload = await this.jwt.verifyAsync<SessionPayload>(token);
    } catch {
      return null;
    }
    const id = Number(payload.sub);
    if (!Number.isInteger(id)) {
      return null;
    }
    const manager = await this.prisma.manager.findUnique({ where: { id } });
    const valid =
      manager?.status === ManagerStatus.ACTIVE && manager.sessionVersion === payload.ver;
    return valid ? manager : null;
  }

  private async bootstrapsAdmin(telegramId: bigint, existing: Manager | null): Promise<boolean> {
    if (existing?.status === ManagerStatus.ACTIVE || existing?.status === ManagerStatus.REJECTED) {
      return false;
    }
    const others = await this.prisma.manager.count({ where: { telegramId: { not: telegramId } } });
    return others === 0;
  }

  private ensureActive(manager: Manager | null): Manager {
    if (!manager) {
      throw AuthErrors.notRegistered();
    }
    if (manager.status === ManagerStatus.PENDING) {
      throw AuthErrors.accessPending();
    }
    if (manager.status === ManagerStatus.REJECTED) {
      throw AuthErrors.accessRejected();
    }
    return manager;
  }

  private async issue(manager: Manager): Promise<SessionResponse> {
    const payload: SessionPayload = { sub: String(manager.id), ver: manager.sessionVersion };
    return {
      token: await this.jwt.signAsync(payload),
      expiresAt: new Date(Date.now() + SESSION_TTL_SECONDS * 1000).toISOString(),
      manager: toMeResponse(manager),
    };
  }
}
