import { Logger } from '@nestjs/common';
import type {
  FinanceRequestCard,
  FinanceRequestFile,
  Manager,
  Order,
} from '../../../src/generated/prisma/client';
import type { PrismaService } from '../../../src/common/prisma/prisma.service';
import { AttachmentStorageError } from '../../../src/modules/attachments/attachments.errors';
import type {
  AttachmentsService,
  TelegramFileRef,
} from '../../../src/modules/attachments/attachments.service';
import type { RequestCardsRepository } from '../../../src/modules/finance-sync/request-cards.repository';
import { RequestReceiptsService } from '../../../src/modules/finance-sync/request-receipts.service';
import { NOT_A_MANAGER } from '../../../src/modules/telegram/access/access.messages';
import type { ManagersService } from '../../../src/modules/managers/managers.service';

const manager = { id: 4, telegramId: 555n, name: 'Уляна' } as Manager;
const open = {
  requestId: 'req1',
  managerId: 4,
  completedAt: null,
  orderIds: [],
} as unknown as FinanceRequestCard;
const done = {
  requestId: 'req1',
  managerId: 4,
  completedAt: new Date(),
  orderIds: [10, 11],
} as unknown as FinanceRequestCard;
const order = { id: 10, orderNumber: '0000-070217' } as Order;

const photo: TelegramFileRef = {
  fileId: 'f1',
  filename: 'photo.jpg',
  mimeType: 'image/jpeg',
  size: 1000,
  kind: 'photo',
};

describe('RequestReceiptsService', () => {
  const cards = {
    byRequestId: jest.fn(),
    byManagerMessage: jest.fn(),
    requestOfChatMessage: jest.fn(),
    holdFile: jest.fn(),
    heldFiles: jest.fn(),
    deleteHeldFiles: jest.fn(),
  };
  const prisma = { order: { findUnique: jest.fn() } };
  const attachments = { saveFromTelegram: jest.fn() };
  const managers = { findActiveByTelegramId: jest.fn() };
  const drafts = { isArmed: jest.fn().mockReturnValue(false) };
  const service = new RequestReceiptsService(
    cards as unknown as RequestCardsRepository,
    prisma as unknown as PrismaService,
    attachments as unknown as AttachmentsService,
    managers as unknown as ManagersService,
    drafts as never,
  );
  let logError: jest.SpyInstance;

  beforeEach(() => {
    logError = jest.spyOn(Logger.prototype, 'error').mockImplementation();
    cards.byRequestId.mockResolvedValue(open);
    cards.heldFiles.mockResolvedValue([]);
    prisma.order.findUnique.mockResolvedValue(order);
    attachments.saveFromTelegram.mockResolvedValue([]);
  });
  afterEach(() => {
    jest.resetAllMocks();
    jest.restoreAllMocks();
  });

  describe('receive', () => {
    it('should hold the receipt while the request is not completed', async () => {
      const answer = await service.receive(manager, 'req1', photo);

      expect(cards.holdFile).toHaveBeenCalledWith('req1', photo);
      expect(attachments.saveFromTelegram).not.toHaveBeenCalled();
      expect(answer.html).toBe('📎 Квитанцію збережено — додамо до замовлення після оформлення');
    });

    it('should refuse an eleventh held file and store nothing', async () => {
      cards.heldFiles.mockResolvedValue(Array.from({ length: 10 }, (_, id) => ({ id })));

      const answer = await service.receive(manager, 'req1', photo);

      expect(answer.html).toBe('⚠️ Максимум 10 файлів на замовлення.');
      expect(cards.holdFile).not.toHaveBeenCalled();
    });

    it('should attach the receipt to the first created order when the request is completed', async () => {
      cards.byRequestId.mockResolvedValue(done);

      const answer = await service.receive(manager, 'req1', photo);

      expect(prisma.order.findUnique).toHaveBeenCalledWith({ where: { id: 10 } });
      expect(attachments.saveFromTelegram).toHaveBeenCalledWith(
        order,
        [photo],
        { telegramId: 555n, name: 'Уляна' },
        true,
      );
      expect(cards.holdFile).not.toHaveBeenCalled();
      expect(answer.html).toBe('📎 Квитанцію додано до № 0000-070217');
    });

    it('should hold the receipt while completion runs: completedAt set, no order ids yet', async () => {
      cards.byRequestId.mockResolvedValue({ ...done, orderIds: [] });

      const answer = await service.receive(manager, 'req1', photo);

      expect(cards.holdFile).toHaveBeenCalledWith('req1', photo);
      expect(attachments.saveFromTelegram).not.toHaveBeenCalled();
      expect(answer.html).toBe('📎 Квитанцію збережено — додамо до замовлення після оформлення');
    });

    it('should attach a file held in the window once the ids appear right after the hold', async () => {
      // first read: completion claimed, no ids; second read (after the hold): ids stored
      cards.byRequestId
        .mockResolvedValueOnce({ ...done, orderIds: [] })
        .mockResolvedValueOnce(done);
      const held = {
        id: 7,
        requestId: 'req1',
        fileId: 'f1',
        filename: 'photo.jpg',
        mimeType: 'image/jpeg',
        size: 1000,
        kind: 'photo',
      };
      cards.heldFiles.mockResolvedValueOnce([]).mockResolvedValueOnce([held]);

      const answer = await service.receive(manager, 'req1', photo);

      expect(cards.holdFile).toHaveBeenCalledWith('req1', photo);
      expect(attachments.saveFromTelegram).toHaveBeenCalledWith(
        order,
        [photo],
        { telegramId: 555n, name: 'Уляна' },
        true,
      );
      expect(cards.deleteHeldFiles).toHaveBeenCalledWith([7]);
      expect(answer.html).toBe('📎 Квитанцію додано до № 0000-070217');
    });

    it('should give the same answer when the created order no longer exists', async () => {
      cards.byRequestId.mockResolvedValue(done);
      prisma.order.findUnique.mockResolvedValue(null);

      const answer = await service.receive(manager, 'req1', photo);

      expect(answer.html).toContain('бот не знайшов замовлення');
      expect(attachments.saveFromTelegram).not.toHaveBeenCalled();
      expect(logError).toHaveBeenCalled();
    });

    it('should refuse an unsupported file type with the existing text', async () => {
      const answer = await service.receive(manager, 'req1', { ...photo, mimeType: 'video/mp4' });

      expect(answer.html).toBe(
        '⚠️ Такий тип файлу не підтримується. Додайте фото, PDF або зображення.',
      );
      expect(cards.holdFile).not.toHaveBeenCalled();
    });

    it('should refuse a file over 10 MB with the existing text', async () => {
      const answer = await service.receive(manager, 'req1', {
        ...photo,
        size: 10 * 1024 * 1024 + 1,
      });

      expect(answer.html).toBe('⚠️ Файл завеликий. Максимум 10 МБ.');
      expect(cards.holdFile).not.toHaveBeenCalled();
    });

    it('should tell the manager the receipt was not saved when Telegram storage fails', async () => {
      cards.byRequestId.mockResolvedValue(done);
      attachments.saveFromTelegram.mockRejectedValue(new AttachmentStorageError());

      const answer = await service.receive(manager, 'req1', photo);

      expect(answer.html).toBe('⚠️ Не вдалося зберегти квитанцію, спробуйте ще раз');
    });

    it('should let an unexpected error through', async () => {
      cards.byRequestId.mockResolvedValue(done);
      attachments.saveFromTelegram.mockRejectedValue(new Error('boom'));

      await expect(service.receive(manager, 'req1', photo)).rejects.toThrow('boom');
    });
  });

  describe('attachHeld', () => {
    const row = (id: number, kind: 'photo' | 'document') =>
      ({
        id,
        requestId: 'req1',
        fileId: `f${id}`,
        filename: `n${id}`,
        mimeType: 'image/jpeg',
        size: 5,
        kind,
        createdAt: new Date(),
      }) as FinanceRequestFile;

    it('should attach the held files to the order and delete exactly those rows', async () => {
      cards.heldFiles.mockResolvedValue([row(1, 'photo'), row(2, 'document')]);

      await service.attachHeld(manager, 'req1', order);

      expect(attachments.saveFromTelegram).toHaveBeenCalledWith(
        order,
        [
          { fileId: 'f1', filename: 'n1', mimeType: 'image/jpeg', size: 5, kind: 'photo' },
          { fileId: 'f2', filename: 'n2', mimeType: 'image/jpeg', size: 5, kind: 'document' },
        ],
        { telegramId: 555n, name: 'Уляна' },
        true,
      );
      expect(cards.deleteHeldFiles).toHaveBeenCalledWith([1, 2]);
    });

    it('should do nothing when no receipt was held', async () => {
      cards.heldFiles.mockResolvedValue([]);

      await service.attachHeld(manager, 'req1', order);

      expect(attachments.saveFromTelegram).not.toHaveBeenCalled();
      expect(cards.deleteHeldFiles).not.toHaveBeenCalled();
    });

    it('should keep the rows when attaching fails', async () => {
      cards.heldFiles.mockResolvedValue([row(1, 'photo')]);
      attachments.saveFromTelegram.mockRejectedValue(new AttachmentStorageError());

      await expect(service.attachHeld(manager, 'req1', order)).rejects.toThrow(
        AttachmentStorageError,
      );

      expect(cards.deleteHeldFiles).not.toHaveBeenCalled();
    });
  });

  describe('onFile', () => {
    const ctx = (patch: Record<string, unknown> = {}) => ({
      chat: { id: 555, type: 'private' },
      from: { id: 555 },
      message: { message_id: 90, reply_to_message: { message_id: 31 } },
      reply: jest.fn(),
      react: jest.fn().mockResolvedValue(true),
      ...patch,
    });

    beforeEach(() => {
      managers.findActiveByTelegramId.mockResolvedValue(manager);
      cards.byManagerMessage.mockResolvedValue(open);
    });

    it('should keep a file replied to the manager card and answer with a 👍, not a message', async () => {
      const c = ctx();
      const next = jest.fn();

      await service.onFile(c as never, photo, next);

      expect(cards.byManagerMessage).toHaveBeenCalledWith(555n, 31);
      expect(cards.holdFile).toHaveBeenCalledWith('req1', photo);
      expect(c.react).toHaveBeenCalledWith('👍');
      expect(c.reply).not.toHaveBeenCalled();
      expect(next).not.toHaveBeenCalled();
    });

    it('should fall back to the text when the reaction fails', async () => {
      const c = ctx({ react: jest.fn().mockRejectedValue(new Error('no reactions')) });

      await service.onFile(c as never, photo, jest.fn());

      expect(c.reply).toHaveBeenCalledWith(
        '📎 Квитанцію збережено — додамо до замовлення після оформлення',
        expect.objectContaining({
          reply_parameters: { message_id: 90, allow_sending_without_reply: true },
        }),
      );
    });

    it('should answer a refused file with a message', async () => {
      const c = ctx();

      await service.onFile(c as never, { ...photo, mimeType: 'video/mp4' }, jest.fn());

      expect(c.react).not.toHaveBeenCalled();
      expect(c.reply).toHaveBeenCalledWith(
        expect.stringContaining('не підтримується'),
        expect.anything(),
      );
    });

    it('should receive a file replied to a remembered chat message', async () => {
      cards.byManagerMessage.mockResolvedValue(null);
      cards.requestOfChatMessage.mockResolvedValue('req1');

      await service.onFile(ctx() as never, photo, jest.fn());

      expect(cards.requestOfChatMessage).toHaveBeenCalledWith(555n, 31);
      expect(cards.holdFile).toHaveBeenCalledWith('req1', photo);
    });

    it.each([
      ['not a reply', { message: { message_id: 90 } }],
      ['a group chat', { chat: { id: -100, type: 'supergroup' } }],
    ])('should call next for %s', async (_name, patch) => {
      const next = jest.fn();

      await service.onFile(ctx(patch) as never, photo, next);

      expect(next).toHaveBeenCalledTimes(1);
      expect(cards.holdFile).not.toHaveBeenCalled();
    });

    it('should call next for a reply to a message that belongs to no request', async () => {
      cards.byManagerMessage.mockResolvedValue(null);
      cards.requestOfChatMessage.mockResolvedValue(null);
      const next = jest.fn();

      await service.onFile(ctx() as never, photo, next);

      expect(next).toHaveBeenCalledTimes(1);
    });

    it("should call next for a reply to another manager's request", async () => {
      cards.byRequestId.mockResolvedValue({ ...open, managerId: 9 });
      const next = jest.fn();

      await service.onFile(ctx() as never, photo, next);

      expect(next).toHaveBeenCalledTimes(1);
      expect(cards.holdFile).not.toHaveBeenCalled();
    });

    it('should answer NOT_A_MANAGER and hold nothing when the sender is not an active manager', async () => {
      managers.findActiveByTelegramId.mockResolvedValue(null);
      const c = ctx();
      const next = jest.fn();

      await service.onFile(c as never, photo, next);

      expect(next).not.toHaveBeenCalled();
      expect(cards.holdFile).not.toHaveBeenCalled();
      expect(c.reply).toHaveBeenCalledWith(NOT_A_MANAGER, expect.anything());
    });
  });
});
