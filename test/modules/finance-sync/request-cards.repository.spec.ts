import { Test } from '@nestjs/testing';
import { Prisma } from '../../../src/generated/prisma/client';
import { PrismaService } from '../../../src/common/prisma/prisma.service';
import { RequestCardsRepository } from '../../../src/modules/finance-sync/request-cards.repository';

describe('RequestCardsRepository', () => {
  const financeRequestCard = {
    create: jest.fn(),
    findFirst: jest.fn(),
    findUnique: jest.fn(),
    update: jest.fn(),
    updateMany: jest.fn(),
  };
  const financeMessageSeen = { create: jest.fn(), deleteMany: jest.fn() };
  const financeChatMessage = { upsert: jest.fn(), findUnique: jest.fn() };
  const financeRequestFile = { create: jest.fn(), findMany: jest.fn(), deleteMany: jest.fn() };
  let repository: RequestCardsRepository;

  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [
        RequestCardsRepository,
        {
          provide: PrismaService,
          useValue: {
            financeRequestCard,
            financeMessageSeen,
            financeChatMessage,
            financeRequestFile,
          },
        },
      ],
    }).compile();

    repository = moduleRef.get(RequestCardsRepository);
  });

  afterEach(() => jest.resetAllMocks());

  it('should create a card from the given data', async () => {
    const card = {
      requestId: 'r1',
      number: '12',
      managerId: 1,
      managerChatId: 5n,
      groupChatId: -100n,
      groupMessageId: 7,
    };
    financeRequestCard.create.mockResolvedValue(card);

    await expect(repository.create(card)).resolves.toBe(card);
    expect(financeRequestCard.create).toHaveBeenCalledWith({ data: card });
  });

  it('should find a card by request id and by group message', async () => {
    financeRequestCard.findUnique.mockResolvedValue(null);

    await repository.byRequestId('r1');
    expect(financeRequestCard.findUnique).toHaveBeenCalledWith({ where: { requestId: 'r1' } });

    await repository.byGroupMessage(-100n, 7);
    expect(financeRequestCard.findUnique).toHaveBeenCalledWith({
      where: { groupChatId_groupMessageId: { groupChatId: -100n, groupMessageId: 7 } },
    });
  });

  it('should find the newest card of a group chat by request number', async () => {
    await repository.byNumber(-100n, '42');

    expect(financeRequestCard.findFirst).toHaveBeenCalledWith({
      where: { groupChatId: -100n, number: '42' },
      orderBy: { createdAt: 'desc' },
    });
  });

  it('should store the manager message id and the pending rate', async () => {
    await repository.setManagerMessage('r1', 9);
    expect(financeRequestCard.update).toHaveBeenCalledWith({
      where: { requestId: 'r1' },
      data: { managerMessageId: 9 },
    });

    await repository.setPendingRate('r1', null);
    expect(financeRequestCard.update).toHaveBeenCalledWith({
      where: { requestId: 'r1' },
      data: { pendingRate: null },
    });
  });

  describe('markNotified', () => {
    it('should return true when the status changed', async () => {
      financeRequestCard.updateMany.mockResolvedValue({ count: 1 });

      await expect(repository.markNotified('r1', 'PAID')).resolves.toBe(true);
      expect(financeRequestCard.updateMany).toHaveBeenCalledWith({
        where: {
          requestId: 'r1',
          OR: [{ notifiedStatus: null }, { notifiedStatus: { not: 'PAID' } }],
        },
        data: { notifiedStatus: 'PAID' },
      });
    });

    it('should return false the second time for the same status', async () => {
      financeRequestCard.updateMany
        .mockResolvedValueOnce({ count: 1 })
        .mockResolvedValueOnce({ count: 0 });

      await expect(repository.markNotified('r1', 'PAID')).resolves.toBe(true);
      await expect(repository.markNotified('r1', 'PAID')).resolves.toBe(false);
    });
  });

  describe('markSeen', () => {
    it('should return true for a new message', async () => {
      financeMessageSeen.create.mockResolvedValue({});

      await expect(repository.markSeen('m1')).resolves.toBe(true);
      expect(financeMessageSeen.create).toHaveBeenCalledWith({ data: { messageId: 'm1' } });
    });

    it('should return false on a unique violation', async () => {
      financeMessageSeen.create.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('dup', { code: 'P2002', clientVersion: 'x' }),
      );

      await expect(repository.markSeen('m1')).resolves.toBe(false);
    });

    it('should rethrow other errors', async () => {
      financeMessageSeen.create.mockRejectedValue(new Error('db down'));

      await expect(repository.markSeen('m1')).rejects.toThrow('db down');
    });
  });

  it('should find a card by its manager message', async () => {
    await repository.byManagerMessage(555n, 31);

    expect(financeRequestCard.findFirst).toHaveBeenCalledWith({
      where: { managerChatId: 555n, managerMessageId: 31 },
    });
  });

  describe('resetNotified', () => {
    it('should clear the status only while it still equals the given one', async () => {
      await repository.resetNotified('r1', 'accepted');

      expect(financeRequestCard.updateMany).toHaveBeenCalledWith({
        where: { requestId: 'r1', notifiedStatus: 'accepted' },
        data: { notifiedStatus: null },
      });
    });
  });

  describe('unmarkSeen', () => {
    it('should forget a finance message so a retry delivers it', async () => {
      await repository.unmarkSeen('m1');

      expect(financeMessageSeen.deleteMany).toHaveBeenCalledWith({ where: { messageId: 'm1' } });
    });
  });

  describe('completion', () => {
    it('should claim a completion only while completedAt is null', async () => {
      const now = new Date('2026-11-04T10:00:00Z');
      financeRequestCard.updateMany.mockResolvedValueOnce({ count: 1 });
      financeRequestCard.updateMany.mockResolvedValueOnce({ count: 0 });

      await expect(repository.claimCompletion('r1', now)).resolves.toBe(true);
      await expect(repository.claimCompletion('r1', now)).resolves.toBe(false);

      expect(financeRequestCard.updateMany).toHaveBeenCalledWith({
        where: { requestId: 'r1', completedAt: null },
        data: { completedAt: now },
      });
    });

    it('should release a claim and store the order ids', async () => {
      await repository.releaseCompletion('r1');
      await repository.setOrderIds('r1', [3, 4]);

      expect(financeRequestCard.updateMany).toHaveBeenCalledWith({
        where: { requestId: 'r1' },
        data: { completedAt: null },
      });
      expect(financeRequestCard.update).toHaveBeenCalledWith({
        where: { requestId: 'r1' },
        data: { orderIds: [3, 4] },
      });
    });
  });

  describe('chat messages', () => {
    it('should remember and look up the request of a bot message', async () => {
      financeChatMessage.findUnique.mockResolvedValue({ requestId: 'r1' });

      await repository.rememberChatMessage(555n, 40, 'r1');
      await expect(repository.requestOfChatMessage(555n, 40)).resolves.toBe('r1');

      expect(financeChatMessage.upsert).toHaveBeenCalledWith({
        where: { chatId_messageId: { chatId: 555n, messageId: 40 } },
        create: { chatId: 555n, messageId: 40, requestId: 'r1' },
        update: { requestId: 'r1' },
      });
      expect(financeChatMessage.findUnique).toHaveBeenCalledWith({
        where: { chatId_messageId: { chatId: 555n, messageId: 40 } },
      });
    });

    it('should answer null for an unknown message', async () => {
      financeChatMessage.findUnique.mockResolvedValue(null);

      await expect(repository.requestOfChatMessage(555n, 41)).resolves.toBeNull();
    });
  });

  describe('held receipts', () => {
    const file = {
      fileId: 'f1',
      filename: 'photo.jpg',
      mimeType: 'image/jpeg',
      size: 10,
      kind: 'photo' as const,
    };

    it('should store, list in arrival order and delete held files', async () => {
      await repository.holdFile('r1', file);
      await repository.heldFiles('r1');
      await repository.deleteHeldFiles([1, 2]);

      expect(financeRequestFile.create).toHaveBeenCalledWith({
        data: { requestId: 'r1', ...file },
      });
      expect(financeRequestFile.findMany).toHaveBeenCalledWith({
        where: { requestId: 'r1' },
        orderBy: { id: 'asc' },
      });
      expect(financeRequestFile.deleteMany).toHaveBeenCalledWith({ where: { id: { in: [1, 2] } } });
    });
  });
});
