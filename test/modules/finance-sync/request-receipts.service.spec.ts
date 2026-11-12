import { Logger } from '@nestjs/common';
import type {
  FinanceRequestCard,
  FinanceRequestFile,
  Manager,
  Order,
  OrderRequisite,
} from '../../../src/generated/prisma/client';
import { Prisma } from '../../../src/generated/prisma/client';
import type { PrismaService } from '../../../src/common/prisma/prisma.service';
import { AttachmentStorageError } from '../../../src/modules/attachments/attachments.errors';
import type {
  AttachmentsService,
  TelegramFileRef,
} from '../../../src/modules/attachments/attachments.service';
import type { PendingOrdersRepository } from '../../../src/modules/finance-sync/pending-orders.repository';
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
    rememberChatMessage: jest.fn(),
    openOfManager: jest.fn(),
  };
  const prisma = {
    order: { findUnique: jest.fn() },
    orderRequisite: { findMany: jest.fn(), findFirst: jest.fn() },
  };
  const attachments = { saveFromTelegram: jest.fn() };
  const managers = { findActiveByTelegramId: jest.fn() };
  const drafts = { isArmed: jest.fn().mockReturnValue(false) };
  const pending = {
    idOfMessage: jest.fn(),
    byId: jest.fn(),
    addFile: jest.fn(),
    openOfManager: jest.fn(),
  };
  const service = new RequestReceiptsService(
    cards as unknown as RequestCardsRepository,
    prisma as unknown as PrismaService,
    attachments as unknown as AttachmentsService,
    managers as unknown as ManagersService,
    drafts as never,
    pending as unknown as PendingOrdersRepository,
  );
  let logError: jest.SpyInstance;

  beforeEach(() => {
    logError = jest.spyOn(Logger.prototype, 'error').mockImplementation();
    cards.byRequestId.mockResolvedValue(open);
    cards.heldFiles.mockResolvedValue([]);
    prisma.order.findUnique.mockResolvedValue(order);
    prisma.orderRequisite.findMany.mockResolvedValue([]);
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
        undefined,
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
        undefined,
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
        undefined,
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
      (service as unknown as { heldNotified: Map<number, number> }).heldNotified.clear();
      pending.openOfManager.mockResolvedValue([]);
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
      expect(c.reply).toHaveBeenCalledWith(
        '📎 Квитанцію збережено — додамо до замовлення після оформлення',
        expect.anything(),
      );
      expect(next).not.toHaveBeenCalled();
    });

    it('should say that a held file waits only once for a burst of files', async () => {
      const c = ctx();

      await service.onFile(c as never, photo, jest.fn());
      await service.onFile(c as never, { ...photo, fileId: 'f2' }, jest.fn());

      expect(c.react).toHaveBeenCalledTimes(2);
      expect(c.reply).toHaveBeenCalledTimes(1);
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

    describe('replied to a direct order card', () => {
      const draft = { id: 'p1', managerId: 4 };

      beforeEach(() => {
        cards.byManagerMessage.mockResolvedValue(null);
        cards.requestOfChatMessage.mockResolvedValue(null);
        pending.idOfMessage.mockResolvedValue('p1');
        pending.byId.mockResolvedValue(draft);
        pending.addFile.mockResolvedValue('added');
      });

      it('should hold the file on the draft and answer with a 👍', async () => {
        const c = ctx();
        const next = jest.fn();

        await service.onFile(c as never, photo, next);

        expect(pending.idOfMessage).toHaveBeenCalledWith(555n, 31);
        expect(pending.addFile).toHaveBeenCalledWith('p1', photo, 10);
        expect(c.react).toHaveBeenCalledWith('👍');
        expect(next).not.toHaveBeenCalled();
      });

      it('should hold the file on the draft when the reply is to its remembered attach prompt', async () => {
        // the prompt is remembered in the request-chat table, so it resolves to the draft id as a "request id"
        cards.requestOfChatMessage.mockResolvedValue('p1');
        cards.byRequestId.mockResolvedValue(null);
        const c = ctx();
        const next = jest.fn();

        await service.onFile(c as never, photo, next);

        expect(pending.addFile).toHaveBeenCalledWith('p1', photo, 10);
        expect(c.react).toHaveBeenCalledWith('👍');
        expect(next).not.toHaveBeenCalled();
      });

      it('should refuse a file type the receipts flow refuses', async () => {
        const c = ctx();

        await service.onFile(c as never, { ...photo, mimeType: 'application/zip' }, jest.fn());

        expect(pending.addFile).not.toHaveBeenCalled();
        expect(c.reply).toHaveBeenCalledWith(
          expect.stringContaining('не підтримується'),
          expect.anything(),
        );
      });

      it('should say the limit is reached when the draft is full', async () => {
        pending.addFile.mockResolvedValue('full');
        const c = ctx();

        await service.onFile(c as never, photo, jest.fn());

        expect(c.reply).toHaveBeenCalledWith(
          '⚠️ Максимум 10 файлів на замовлення.',
          expect.anything(),
        );
      });

      it('should say the request is gone when the draft was taken meanwhile', async () => {
        pending.addFile.mockResolvedValue('gone');
        const c = ctx();

        await service.onFile(c as never, photo, jest.fn());

        expect(c.reply).toHaveBeenCalledWith('Запит не знайдено', expect.anything());
      });

      it('should leave a draft of another manager to the next handler', async () => {
        pending.byId.mockResolvedValue({ id: 'p1', managerId: 99 });
        const next = jest.fn();

        await service.onFile(ctx() as never, photo, next);

        expect(pending.addFile).not.toHaveBeenCalled();
        expect(next).toHaveBeenCalled();
      });

      it('should leave a reply to an unknown message to the next handler', async () => {
        pending.idOfMessage.mockResolvedValue(null);
        const next = jest.fn();

        await service.onFile(ctx() as never, photo, next);

        expect(next).toHaveBeenCalled();
      });
    });

    it('should receive a file replied to a remembered chat message', async () => {
      cards.byManagerMessage.mockResolvedValue(null);
      cards.requestOfChatMessage.mockResolvedValue('req1');

      await service.onFile(ctx() as never, photo, jest.fn());

      expect(cards.requestOfChatMessage).toHaveBeenCalledWith(555n, 31);
      expect(cards.holdFile).toHaveBeenCalledWith('req1', photo);
    });

    it('should call next for a group chat', async () => {
      const next = jest.fn();

      await service.onFile(ctx({ chat: { id: -100, type: 'supergroup' } }) as never, photo, next);

      expect(next).toHaveBeenCalledTimes(1);
      expect(cards.holdFile).not.toHaveBeenCalled();
    });

    describe('a file sent loose, not as a reply', () => {
      const loose = (patch: Record<string, unknown> = {}) =>
        ctx({ message: { message_id: 90 }, ...patch });
      const card = (requestId: string, number: string) => ({ requestId, number });

      beforeEach(() => {
        drafts.isArmed.mockReturnValue(false);
      });

      it('should call next while a Kit, cash or foreign text mode is armed', async () => {
        drafts.isArmed.mockReturnValue(true);
        const next = jest.fn();

        await service.onFile(loose() as never, photo, next);

        expect(next).toHaveBeenCalledTimes(1);
        expect(cards.openOfManager).not.toHaveBeenCalled();
        expect(cards.holdFile).not.toHaveBeenCalled();
      });

      it('should keep it on the only open request and answer with a 👍', async () => {
        cards.openOfManager.mockResolvedValue([card('req1', '42')]);
        const c = loose();
        const next = jest.fn();

        await service.onFile(c as never, photo, next);

        expect(cards.holdFile).toHaveBeenCalledWith('req1', photo);
        expect(c.react).toHaveBeenCalledWith('👍');
        expect(next).not.toHaveBeenCalled();
      });

      it('should say there is no open request', async () => {
        cards.openOfManager.mockResolvedValue([]);
        const c = loose();

        await service.onFile(c as never, photo, jest.fn());

        expect(c.reply).toHaveBeenCalledWith(
          'Немає відкритого запиту чи замовлення, до якого можна додати файл.',
          expect.anything(),
        );
        expect(cards.holdFile).not.toHaveBeenCalled();
      });

      it('should hold a loose file on the only draft', async () => {
        cards.openOfManager.mockResolvedValue([]);
        pending.openOfManager.mockResolvedValue([
          { id: 'p1', managerId: 4, plan: { kind: 'foreign', plan: { number: '0000-066498' } } },
        ]);
        pending.addFile.mockResolvedValue('added');
        const c = loose();

        await service.onFile(c as never, photo, jest.fn());

        expect(pending.addFile).toHaveBeenCalledWith('p1', photo, 10);
        expect(c.react).toHaveBeenCalledWith('👍');
      });

      it('should offer requests and drafts together and give the files to the chosen draft', async () => {
        cards.openOfManager.mockResolvedValue([card('req1', '42')]);
        pending.openOfManager.mockResolvedValue([
          { id: 'p1', managerId: 4, plan: { kind: 'foreign', plan: { number: '0000-066498' } } },
        ]);
        pending.addFile.mockResolvedValue('added');
        const c = loose();

        await service.onFile(c as never, photo, jest.fn());
        await service.onFile(loose() as never, { ...photo, fileId: 'f2' }, jest.fn());

        const question = JSON.stringify(c.reply.mock.calls[0]);
        expect(question).toContain('mr:req1');
        expect(question).toContain('mr:p1');
        expect(question).toContain('Замовлення № 0000-066498');

        cards.byRequestId.mockResolvedValue(null);
        pending.byId.mockResolvedValue({
          id: 'p1',
          managerId: 4,
          plan: { kind: 'foreign', plan: { number: '0000-066498' } },
        });
        const cb = {
          from: { id: 555 },
          chat: { id: 555, type: 'private' },
          match: ['mr:p1', 'p1'],
          answerCbQuery: jest.fn(),
          editMessageText: jest.fn().mockResolvedValue(true),
          deleteMessage: jest.fn(),
        };
        await service.onChoice(cb as never);

        expect(pending.addFile).toHaveBeenCalledTimes(2);
        expect(pending.addFile).toHaveBeenCalledWith('p1', { ...photo, fileId: 'f2' }, 10);
        expect(cb.editMessageText).toHaveBeenCalledWith(
          '📎 Збережено до замовлення № 0000-066498: 2. У «Оплати» піде після «Прийняти».',
        );
      });

      it('should ask once for an album sent at the same time, and keep every photo for the chosen request', async () => {
        cards.openOfManager.mockImplementation(
          () =>
            new Promise((resolve) =>
              setTimeout(() => resolve([card('req1', '42'), card('req2', '43')]), 0),
            ),
        );
        const first = loose();
        const second = loose();

        await Promise.all([
          service.onFile(first as never, photo, jest.fn()),
          service.onFile(second as never, { ...photo, fileId: 'f2' }, jest.fn()),
        ]);

        expect(first.reply.mock.calls.length + second.reply.mock.calls.length).toBe(1);

        cards.byRequestId.mockResolvedValue({ ...open, requestId: 'req2', number: '43' });
        const cb = {
          from: { id: 555 },
          chat: { id: 555, type: 'private' },
          match: ['mr:req2', 'req2'],
          answerCbQuery: jest.fn(),
          editMessageText: jest.fn().mockResolvedValue(true),
          deleteMessage: jest.fn(),
        };
        await service.onChoice(cb as never);

        expect(cards.holdFile).toHaveBeenCalledTimes(2);
      });

      it('should keep every file of an album sent at the same time to the only open request', async () => {
        cards.openOfManager.mockImplementation(
          () => new Promise((resolve) => setTimeout(() => resolve([card('req1', '42')]), 0)),
        );
        const first = loose();
        const second = loose();

        await Promise.all([
          service.onFile(first as never, photo, jest.fn()),
          service.onFile(second as never, { ...photo, fileId: 'f2' }, jest.fn()),
        ]);

        expect(cards.holdFile).toHaveBeenCalledTimes(2);
        expect(first.reply).toHaveBeenCalledWith('📎 Збережено файлів: 2', expect.anything());
      });

      it('should ask which request with «mr:» buttons, then attach the waiting files to the chosen one', async () => {
        cards.openOfManager.mockResolvedValue([card('req1', '42'), card('req2', '43')]);
        const c = loose();

        await service.onFile(c as never, photo, jest.fn());
        // an album: the second file joins the same question
        await service.onFile(loose() as never, { ...photo, fileId: 'f2' }, jest.fn());

        expect(c.reply).toHaveBeenCalledTimes(1);
        expect(JSON.stringify(c.reply.mock.calls[0])).toContain('До якого запиту');
        expect(JSON.stringify(c.reply.mock.calls[0])).toContain('mr:req2');
        expect(cards.holdFile).not.toHaveBeenCalled();

        cards.byRequestId.mockResolvedValue({ ...open, requestId: 'req2', number: '43' });
        const cb = {
          from: { id: 555 },
          chat: { id: 555, type: 'private' },
          match: ['mr:req2', 'req2'],
          answerCbQuery: jest.fn(),
          editMessageText: jest.fn().mockResolvedValue(true),
          deleteMessage: jest.fn(),
        };
        await service.onChoice(cb as never);

        expect(cards.holdFile).toHaveBeenCalledTimes(2);
        expect(cards.holdFile).toHaveBeenCalledWith('req2', photo);
        expect(cb.editMessageText).toHaveBeenCalledWith(
          '📎 Збережено до запиту #43: 2. У «Оплати» піде після «Прийняти».',
        );
      });
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
  describe('receipts of an order with payments', () => {
    const payment = (id: number, payerName: string, amount: string) =>
      ({
        id,
        orderId: 10,
        payerName,
        account: '4441111149020814',
        amount: new Prisma.Decimal(amount),
        paidAt: null,
      }) as OrderRequisite;
    const first = payment(1, 'Николаев Николай', '7020.8');
    const second = payment(2, 'Костецький Віктор', '2673.96');
    const ctx = (id: number) =>
      ({
        from: { id: 555 },
        chat: { type: 'private', id: 555 },
        match: ['', String(id)],
        answerCbQuery: jest.fn(),
        deleteMessage: jest.fn().mockResolvedValue(undefined),
        editMessageText: jest.fn().mockResolvedValue(undefined),
      }) as never;

    beforeEach(() => {
      // the service is shared, so a question left waiting by one test must not reach the next
      (service as unknown as { paymentChoices: Map<bigint, unknown> }).paymentChoices.clear();
      cards.byRequestId.mockResolvedValue(done);
      managers.findActiveByTelegramId.mockResolvedValue(manager);
    });

    it('should caption the receipt with the only payment of the order', async () => {
      prisma.orderRequisite.findMany.mockResolvedValue([first]);

      await service.receive(manager, 'req1', photo);

      const [, , , , caption] = attachments.saveFromTelegram.mock.calls[0] as [
        unknown,
        unknown,
        unknown,
        unknown,
        string,
      ];
      expect(caption).toContain('Николаев Николай');
      expect(caption).toContain('7 020,80');
      expect(caption).not.toContain('Костецький');
    });

    it('should ask which payment instead of storing when the order has several', async () => {
      prisma.orderRequisite.findMany.mockResolvedValue([first, second]);

      const answer = await service.receive(manager, 'req1', photo);

      expect(attachments.saveFromTelegram).not.toHaveBeenCalled();
      expect(answer.buttons).toHaveLength(2);
      expect(answer.buttons![1]![0]).toMatchObject({ callback_data: 'mp:2' });
    });

    it('should let a second file join the question already asked', async () => {
      prisma.orderRequisite.findMany.mockResolvedValue([first, second]);
      await service.receive(manager, 'req1', photo);

      const answer = await service.receive(manager, 'req1', { ...photo, fileId: 'f2' });

      expect(answer.queued).toBe(true);
      expect(answer.buttons).toBeUndefined();
    });

    it('should store the waiting files with the chosen payment only', async () => {
      prisma.orderRequisite.findMany.mockResolvedValue([first, second]);
      prisma.orderRequisite.findFirst.mockResolvedValue(second);
      await service.receive(manager, 'req1', photo);
      await service.receive(manager, 'req1', { ...photo, fileId: 'f2' });

      await service.onPayment(ctx(2));

      expect(prisma.orderRequisite.findFirst).toHaveBeenCalledWith({
        where: { id: 2, orderId: 10 },
      });
      const [, files, , , caption] = attachments.saveFromTelegram.mock.calls[0] as [
        unknown,
        TelegramFileRef[],
        unknown,
        unknown,
        string,
      ];
      expect(files.map((file) => file.fileId)).toEqual(['f1', 'f2']);
      expect(caption).toContain('Костецький Віктор');
      expect(caption).toContain('2 673,96');
      expect(caption).not.toContain('Николаев');
    });

    it('should refuse a payment press with no waiting files', async () => {
      const press = ctx(2);

      await service.onPayment(press);

      expect(attachments.saveFromTelegram).not.toHaveBeenCalled();
      expect((press as unknown as { answerCbQuery: jest.Mock }).answerCbQuery).toHaveBeenCalledWith(
        'Надішліть файл ще раз',
        { show_alert: true },
      );
    });
  });
  describe('files for an accepted order', () => {
    const mine = { id: 10, orderNumber: '0000-070217', managerId: 4 };
    const press = () => ({
      chat: { id: 555, type: 'private' },
      from: { id: 555 },
      match: ['oa:0000-070217', '0000-070217'],
      answerCbQuery: jest.fn(),
      reply: jest.fn().mockResolvedValue({ message_id: 90 }),
    });

    beforeEach(() => {
      managers.findActiveByTelegramId.mockResolvedValue(manager);
      prisma.order.findUnique.mockResolvedValue(mine);
      pending.openOfManager.mockResolvedValue([]);
    });

    it('should ask for the files as a reply and remember the prompt for the order', async () => {
      const c = press();

      await service.askOrderFiles(c as never);

      expect(prisma.order.findUnique).toHaveBeenCalledWith({
        where: { orderNumber: '0000-070217' },
      });
      const [text, options] = c.reply.mock.calls[0] as [
        string,
        { reply_markup: { force_reply: boolean } },
      ];
      expect(text).toContain('0000-070217');
      expect(options.reply_markup.force_reply).toBe(true);
      expect(cards.rememberChatMessage).toHaveBeenCalledWith(555n, 90, 'order:0000-070217');
    });

    it("should not ask for files of another manager's order", async () => {
      prisma.order.findUnique.mockResolvedValue({ ...mine, managerId: 9 });
      const c = press();

      await service.askOrderFiles(c as never);

      expect(c.reply).not.toHaveBeenCalled();
      expect(c.answerCbQuery).toHaveBeenCalledWith('Замовлення не знайдено', { show_alert: true });
    });

    it('should attach a file replied to the prompt to the order and answer with a 👍', async () => {
      cards.byManagerMessage.mockResolvedValue(null);
      cards.requestOfChatMessage.mockResolvedValue('order:0000-070217');
      const c = {
        chat: { id: 555, type: 'private' },
        from: { id: 555 },
        message: { message_id: 90, reply_to_message: { message_id: 31 } },
        reply: jest.fn(),
        react: jest.fn().mockResolvedValue(true),
      };
      const next = jest.fn();

      await service.onFile(c as never, photo, next);

      expect(attachments.saveFromTelegram).toHaveBeenCalledWith(
        mine,
        [photo],
        { telegramId: 555n, name: 'Уляна' },
        true,
        undefined,
      );
      expect(c.react).toHaveBeenCalledWith('👍');
      expect(next).not.toHaveBeenCalled();
    });

    it("should not attach a file to another manager's order", async () => {
      prisma.order.findUnique.mockResolvedValue({ ...mine, managerId: 9 });
      cards.byManagerMessage.mockResolvedValue(null);
      cards.requestOfChatMessage.mockResolvedValue('order:0000-070217');
      const c = {
        chat: { id: 555, type: 'private' },
        from: { id: 555 },
        message: { message_id: 90, reply_to_message: { message_id: 31 } },
        reply: jest.fn(),
        react: jest.fn(),
      };

      await service.onFile(c as never, photo, jest.fn());

      expect(attachments.saveFromTelegram).not.toHaveBeenCalled();
      expect(c.reply).toHaveBeenCalledWith('Замовлення не знайдено', expect.anything());
    });
  });
});
