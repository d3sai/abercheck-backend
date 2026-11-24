import { EventEmitter2 } from '@nestjs/event-emitter';
import { Test } from '@nestjs/testing';
import { ManagerRole, ManagerStatus, Prisma } from '../../../src/generated/prisma/client';
import { ManagerEvents } from '../../../src/modules/managers/manager.events';
import { PrismaService } from '../../../src/common/prisma/prisma.service';
import { ManagersService } from '../../../src/modules/managers/managers.service';

describe('ManagersService', () => {
  const manager = {
    findUnique: jest.fn(),
    findFirst: jest.fn(),
    create: jest.fn(),
    findMany: jest.fn(),
    update: jest.fn(),
  };
  const events = { emit: jest.fn() };
  const profile = { telegramId: 5000000000n, name: 'Христина', username: 'khrystyna' };
  let service: ManagersService;

  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [
        ManagersService,
        { provide: PrismaService, useValue: { manager } },
        { provide: EventEmitter2, useValue: events },
      ],
    }).compile();

    service = moduleRef.get(ManagersService);
  });

  afterEach(() => jest.resetAllMocks());

  describe('requestAccess', () => {
    it('should activate a new user immediately', async () => {
      manager.findUnique.mockResolvedValue(null);
      manager.create.mockResolvedValue({ id: 1, status: ManagerStatus.ACTIVE });

      await expect(service.requestAccess(profile)).resolves.toMatchObject({ isNew: true });
      expect(manager.create).toHaveBeenCalledWith({
        data: { ...profile, status: ManagerStatus.ACTIVE },
      });
    });

    it('should only refresh the name of a known user without touching the status', async () => {
      manager.findUnique.mockResolvedValue({ id: 1, status: ManagerStatus.REJECTED });
      manager.update.mockResolvedValue({ id: 1, status: ManagerStatus.REJECTED });

      await expect(service.requestAccess(profile)).resolves.toMatchObject({ isNew: false });
      expect(manager.update).toHaveBeenCalledWith({
        where: { id: 1 },
        data: { name: 'Христина', username: 'khrystyna' },
      });
      expect(manager.create).not.toHaveBeenCalled();
    });
  });

  it('should find only active managers by Telegram id', async () => {
    await service.findActiveByTelegramId(5000000000n);

    expect(manager.findFirst).toHaveBeenCalledWith({
      where: { telegramId: 5000000000n, status: ManagerStatus.ACTIVE },
    });
  });

  it('should list pending requests first', async () => {
    manager.findMany.mockResolvedValue([]);

    await service.list();

    expect(manager.findMany).toHaveBeenCalledWith({
      orderBy: [{ status: 'asc' }, { createdAt: 'asc' }],
    });
  });

  describe('updateAccess', () => {
    it('should announce a changed access status', async () => {
      manager.findUnique.mockResolvedValue({ id: 1, status: ManagerStatus.PENDING });
      manager.update.mockResolvedValue({ id: 1, status: ManagerStatus.ACTIVE });

      await expect(
        service.updateAccess(1, { status: ManagerStatus.ACTIVE }),
      ).resolves.toMatchObject({ status: 'ACTIVE' });
      expect(events.emit).toHaveBeenCalledWith(ManagerEvents.AccessChanged, {
        manager: { id: 1, status: ManagerStatus.ACTIVE },
        previousStatus: ManagerStatus.PENDING,
      });
    });

    it('should stay silent when the status does not change', async () => {
      manager.findUnique.mockResolvedValue({ id: 1, status: ManagerStatus.ACTIVE });
      manager.update.mockResolvedValue({ id: 1, status: ManagerStatus.ACTIVE });

      await service.updateAccess(1, { status: ManagerStatus.ACTIVE, role: ManagerRole.ADMIN });

      expect(manager.update).toHaveBeenCalledWith({
        where: { id: 1 },
        data: { status: ManagerStatus.ACTIVE, role: ManagerRole.ADMIN },
      });
      expect(events.emit).not.toHaveBeenCalled();
    });

    it('should return null for an unknown manager', async () => {
      manager.findUnique.mockResolvedValue(null);

      await expect(service.updateAccess(404, { role: ManagerRole.ADMIN })).resolves.toBeNull();
      expect(manager.update).not.toHaveBeenCalled();
    });
  });

  describe('resetCredentials', () => {
    it('should clear the login and password and end every session', async () => {
      manager.update.mockResolvedValue({ id: 1 });

      await service.resetCredentials(1);

      expect(manager.update).toHaveBeenCalledWith({
        where: { id: 1 },
        data: { login: null, passwordHash: null, sessionVersion: { increment: 1 } },
      });
    });

    it('should return null for an unknown manager', async () => {
      manager.update.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('missing', {
          code: 'P2025',
          clientVersion: 'test',
        }),
      );

      await expect(service.resetCredentials(404)).resolves.toBeNull();
    });
  });

  describe('keyboard version', () => {
    it('should find active managers whose keyboard is older than the given version', async () => {
      manager.findMany.mockResolvedValue([]);

      await service.withOldKeyboard(2);

      expect(manager.findMany).toHaveBeenCalledWith({
        where: { status: ManagerStatus.ACTIVE, keyboardVersion: { lt: 2 } },
      });
    });

    it('should remember the keyboard version a manager received', async () => {
      await service.markKeyboard(7, 2);

      expect(manager.update).toHaveBeenCalledWith({
        where: { id: 7 },
        data: { keyboardVersion: 2 },
      });
    });
  });
});
