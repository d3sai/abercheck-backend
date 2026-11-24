import { Injectable } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { type Manager, type ManagerRole, ManagerStatus } from '../../generated/prisma/client';
import { isRecordNotFound } from '../../common/prisma/prisma-errors';
import { PrismaService } from '../../common/prisma/prisma.service';
import { type ManagerAccessChanged, ManagerEvents } from './manager.events';

export interface TelegramProfile {
  telegramId: bigint;
  name: string;
  username: string | null;
}

export interface AccessChange {
  status?: ManagerStatus;
  role?: ManagerRole;
}

@Injectable()
export class ManagersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly events: EventEmitter2,
  ) {}

  findById(id: number): Promise<Manager | null> {
    return this.prisma.manager.findUnique({ where: { id } });
  }

  findActiveByTelegramId(telegramId: bigint): Promise<Manager | null> {
    return this.prisma.manager.findFirst({ where: { telegramId, status: ManagerStatus.ACTIVE } });
  }

  withOldKeyboard(version: number): Promise<Manager[]> {
    return this.prisma.manager.findMany({
      where: { status: ManagerStatus.ACTIVE, keyboardVersion: { lt: version } },
    });
  }

  async markKeyboard(id: number, version: number): Promise<void> {
    await this.prisma.manager.update({ where: { id }, data: { keyboardVersion: version } });
  }

  list(): Promise<Manager[]> {
    return this.prisma.manager.findMany({ orderBy: [{ status: 'asc' }, { createdAt: 'asc' }] });
  }

  async requestAccess(profile: TelegramProfile): Promise<{ manager: Manager; isNew: boolean }> {
    const { telegramId, name, username } = profile;
    const existing = await this.prisma.manager.findUnique({ where: { telegramId } });
    if (existing) {
      const manager = await this.prisma.manager.update({
        where: { id: existing.id },
        data: { name, username },
      });
      return { manager, isNew: false };
    }

    const manager = await this.prisma.manager.create({
      data: { telegramId, name, username, status: ManagerStatus.ACTIVE },
    });
    return { manager, isNew: true };
  }

  async updateAccess(id: number, change: AccessChange): Promise<Manager | null> {
    const existing = await this.findById(id);
    if (!existing) {
      return null;
    }
    const manager = await this.prisma.manager.update({ where: { id }, data: change });
    if (change.status !== undefined && change.status !== existing.status) {
      const event: ManagerAccessChanged = { manager, previousStatus: existing.status };
      this.events.emit(ManagerEvents.AccessChanged, event);
    }
    return manager;
  }

  async resetCredentials(id: number): Promise<Manager | null> {
    try {
      return await this.prisma.manager.update({
        where: { id },
        data: { login: null, passwordHash: null, sessionVersion: { increment: 1 } },
      });
    } catch (error) {
      if (isRecordNotFound(error)) {
        return null;
      }
      throw error;
    }
  }
}
