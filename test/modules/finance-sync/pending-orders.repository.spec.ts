import type { PrismaService } from '../../../src/common/prisma/prisma.service';
import { Prisma, type PendingOrder } from '../../../src/generated/prisma/client';
import type { TelegramFileRef } from '../../../src/modules/attachments/attachments.service';
import { PendingOrdersRepository } from '../../../src/modules/finance-sync/pending-orders.repository';

const file: TelegramFileRef = {
  fileId: 'f1',
  filename: 'photo.jpg',
  mimeType: 'image/jpeg',
  size: 10,
  kind: 'photo',
};
const row = { id: 'p1', managerId: 4, managerChatId: 555n, managerMessageId: 77 } as PendingOrder;
const notFound = () =>
  new Prisma.PrismaClientKnownRequestError('gone', { code: 'P2025', clientVersion: 'test' });

describe('PendingOrdersRepository', () => {
  const prisma = {
    pendingOrder: {
      create: jest.fn(),
      findUnique: jest.fn(),
      findFirst: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
    },
    financeChatMessage: { upsert: jest.fn(), findUnique: jest.fn() },
    $executeRaw: jest.fn(),
  };
  const repo = new PendingOrdersRepository(prisma as unknown as PrismaService);

  afterEach(() => jest.resetAllMocks());

  describe('addFile', () => {
    it('should answer added when the row took the file', async () => {
      prisma.$executeRaw.mockResolvedValue(1);

      expect(await repo.addFile('p1', file, 10)).toBe('added');
    });

    it('should answer full when the row exists but is at the limit', async () => {
      prisma.$executeRaw.mockResolvedValue(0);
      prisma.pendingOrder.findUnique.mockResolvedValue(row);

      expect(await repo.addFile('p1', file, 10)).toBe('full');
    });

    it('should answer gone when there is no row', async () => {
      prisma.$executeRaw.mockResolvedValue(0);
      prisma.pendingOrder.findUnique.mockResolvedValue(null);

      expect(await repo.addFile('p1', file, 10)).toBe('gone');
    });
  });

  describe('claim', () => {
    it('should give the row to the first caller and null to the next', async () => {
      prisma.pendingOrder.delete.mockResolvedValueOnce(row).mockRejectedValueOnce(notFound());

      expect(await repo.claim('p1')).toBe(row);
      expect(await repo.claim('p1')).toBeNull();
    });

    it('should let an unexpected error through', async () => {
      prisma.pendingOrder.delete.mockRejectedValue(new Error('boom'));

      await expect(repo.claim('p1')).rejects.toThrow('boom');
    });
  });

  describe('idOfMessage', () => {
    it('should find a draft by its card message', async () => {
      prisma.pendingOrder.findFirst.mockResolvedValue(row);

      expect(await repo.idOfMessage(555n, 77)).toBe('p1');
      expect(prisma.pendingOrder.findFirst).toHaveBeenCalledWith({
        where: { managerChatId: 555n, managerMessageId: 77 },
      });
    });

    it('should find a draft by a remembered prompt message', async () => {
      prisma.pendingOrder.findFirst.mockResolvedValue(null);
      prisma.financeChatMessage.findUnique.mockResolvedValue({ requestId: 'p1' });
      prisma.pendingOrder.findUnique.mockResolvedValue(row);

      expect(await repo.idOfMessage(555n, 90)).toBe('p1');
    });

    it('should answer null when the remembered message belongs to a request, not a draft', async () => {
      prisma.pendingOrder.findFirst.mockResolvedValue(null);
      prisma.financeChatMessage.findUnique.mockResolvedValue({ requestId: 'req-1' });
      prisma.pendingOrder.findUnique.mockResolvedValue(null);

      expect(await repo.idOfMessage(555n, 90)).toBeNull();
    });
  });
});
