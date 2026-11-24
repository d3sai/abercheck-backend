import { HttpStatus, Logger } from '@nestjs/common';
import { ApiError } from '../../../src/common/api-error';
import { type Manager, type PendingOrder, Prisma } from '../../../src/generated/prisma/client';
import type { TelegramFileRef } from '../../../src/modules/attachments/attachments.service';
import type { PendingOrdersRepository } from '../../../src/modules/finance-sync/pending-orders.repository';
import type { ManagersService } from '../../../src/modules/managers/managers.service';
import type { DirectOrdersService } from '../../../src/modules/miniapp/direct-orders.service';
import type { OrderPlan } from '../../../src/modules/miniapp/miniapp.dto';
import { toStoredPlan } from '../../../src/modules/miniapp/pending-order-plan';
import { PendingOrdersService } from '../../../src/modules/miniapp/pending-orders.service';
import { NOT_A_MANAGER } from '../../../src/modules/telegram/access/access.messages';
import type { TelegramSender } from '../../../src/modules/telegram/core/telegram-sender';

const manager = { id: 4, telegramId: 555n, name: 'Уляна' } as Manager;
const order: OrderPlan = {
  kind: 'foreign',
  plan: {
    number: '0000-066498',
    amount: new Prisma.Decimal('100'),
    currency: 'EUR',
    recipient: 'Абертайм ТОВ',
    rate: '44.9',
    paidAt: new Date('2026-01-15T12:30:00.000Z'),
    comment: null,
    warnings: [],
  },
};
const receipt: TelegramFileRef = {
  fileId: 'f1',
  filename: 'photo.jpg',
  mimeType: 'image/jpeg',
  size: 10,
  kind: 'photo',
};
const row = {
  id: 'p1',
  managerId: 4,
  managerChatId: 555n,
  managerMessageId: 77,
  plan: toStoredPlan(order),
  files: [receipt],
} as unknown as PendingOrder;

describe('PendingOrdersService', () => {
  const repo = {
    create: jest.fn(),
    byId: jest.fn(),
    setMessage: jest.fn(),
    remember: jest.fn(),
    claim: jest.fn(),
    restore: jest.fn(),
    remove: jest.fn(),
  };
  const directOrders = { preview: jest.fn(), create: jest.fn() };
  const sender = { send: jest.fn() };
  const managers = { findActiveByTelegramId: jest.fn() };
  const service = new PendingOrdersService(
    repo as unknown as PendingOrdersRepository,
    directOrders as unknown as DirectOrdersService,
    sender as unknown as TelegramSender,
    managers as unknown as ManagersService,
  );

  const press = (chatId = 555) => ({
    chat: { id: chatId, type: 'private' },
    from: { id: 555 },
    match: ['po:x:p1', 'p1'],
    answerCbQuery: jest.fn(),
    editMessageText: jest.fn().mockResolvedValue(undefined),
    reply: jest.fn().mockResolvedValue({ message_id: 90 }),
  });

  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'error').mockImplementation();
    managers.findActiveByTelegramId.mockResolvedValue(manager);
    repo.byId.mockResolvedValue(row);
    repo.claim.mockResolvedValue(row);
    repo.create.mockResolvedValue(row);
    directOrders.preview.mockResolvedValue({ html: 'card text' });
    directOrders.create.mockResolvedValue({ orderNumbers: ['0000-066498'], skipped: [] });
    sender.send.mockResolvedValue(77);
  });
  afterEach(() => {
    jest.resetAllMocks();
    jest.restoreAllMocks();
  });

  describe('submit', () => {
    it('should send the card with three buttons and remember its message', async () => {
      const result = await service.submit(manager, order);

      expect(repo.create).toHaveBeenCalledWith({
        managerId: 4,
        managerChatId: 555n,
        plan: toStoredPlan(order),
      });
      const [chatId, html, buttons] = sender.send.mock.calls[0] as [
        bigint,
        string,
        { callback_data: string }[][],
      ];
      expect(chatId).toBe(555n);
      expect(html).toBe('card text');
      expect(buttons.flat().map((button) => button.callback_data)).toEqual([
        'po:f:p1',
        'po:a:p1',
        'po:c:p1',
      ]);
      expect(repo.setMessage).toHaveBeenCalledWith('p1', 77);
      expect(result).toMatchObject({ orderNumbers: [], skipped: [] });
      expect(result.note).toContain('Картку надіслано');
    });

    it('should leave no row behind when the card could not be sent', async () => {
      sender.send.mockResolvedValue(null);

      await expect(service.submit(manager, order)).rejects.toMatchObject({
        status: HttpStatus.BAD_GATEWAY,
      });
      expect(repo.remove).toHaveBeenCalledWith('p1');
    });

    it('should create no row when the checks refuse the order', async () => {
      directOrders.preview.mockRejectedValue(
        new ApiError(HttpStatus.CONFLICT, 'already-recorded', 'Цю оплату вже зареєстровано.'),
      );

      await expect(service.submit(manager, order)).rejects.toMatchObject({ status: 409 });
      expect(repo.create).not.toHaveBeenCalled();
    });
  });

  describe('accept', () => {
    it('should create the order with the held files and redraw the card', async () => {
      const c = press();

      await service.accept(c as never);

      expect(directOrders.create).toHaveBeenCalledWith(
        manager,
        expect.objectContaining({ kind: 'foreign' }),
        [receipt],
      );
      const [text, options] = c.editMessageText.mock.calls[0] as [
        string,
        { reply_markup: { inline_keyboard: { callback_data: string }[][] } },
      ];
      expect(text).toContain('card text');
      expect(text).toContain('✅ Оформлено: № 0000-066498');
      expect(options.reply_markup.inline_keyboard.flat().map((b) => b.callback_data)).toEqual([
        'oa:0000-066498',
        'del:0000-066498',
      ]);
      expect(repo.remember).toHaveBeenCalledWith(555n, 77, 'order:0000-066498');
      expect(c.answerCbQuery).toHaveBeenCalledWith('✅ Оформлено');
    });

    it('should not create the order twice when the draft is already taken', async () => {
      repo.claim.mockResolvedValue(null);
      const c = press();

      await service.accept(c as never);

      expect(directOrders.create).not.toHaveBeenCalled();
      expect(c.answerCbQuery).toHaveBeenCalledWith('Запит не знайдено', { show_alert: true });
    });

    it('should give the draft back and show the refusal when the order could not be made', async () => {
      directOrders.create.mockRejectedValue(
        new ApiError(HttpStatus.CONFLICT, 'order-taken', 'Номер щойно зʼявився в системі.'),
      );
      const c = press();

      await service.accept(c as never);

      expect(repo.restore).toHaveBeenCalledWith(row);
      expect(c.answerCbQuery).toHaveBeenCalledWith('Номер щойно зʼявився в системі.', {
        show_alert: true,
      });
    });

    it('should give the draft back and ask to retry on an unexpected error', async () => {
      directOrders.create.mockRejectedValue(new Error('boom'));
      const c = press();

      await service.accept(c as never);

      expect(repo.restore).toHaveBeenCalledWith(row);
      expect(c.answerCbQuery).toHaveBeenCalledWith('Не вдалося, спробуйте ще раз', {
        show_alert: true,
      });
    });

    it('should keep the draft when the checks before creating refuse it', async () => {
      directOrders.preview.mockRejectedValue(
        new ApiError(HttpStatus.CONFLICT, 'already-recorded', 'Цю оплату вже зареєстровано.'),
      );
      const c = press();

      await service.accept(c as never);

      expect(directOrders.create).not.toHaveBeenCalled();
      expect(repo.restore).toHaveBeenCalledWith(row);
    });

    it('should not touch a draft of another chat', async () => {
      const c = press(999);

      await service.accept(c as never);

      expect(repo.claim).not.toHaveBeenCalled();
      expect(c.answerCbQuery).toHaveBeenCalledWith('Запит не знайдено', { show_alert: true });
    });

    it('should refuse someone who is not an active manager', async () => {
      managers.findActiveByTelegramId.mockResolvedValue(null);
      const c = press();

      await service.accept(c as never);

      expect(repo.claim).not.toHaveBeenCalled();
      expect(c.answerCbQuery).toHaveBeenCalledWith(NOT_A_MANAGER, { show_alert: true });
    });
  });

  describe('cancel', () => {
    it('should delete the draft and redraw the card', async () => {
      const c = press();

      await service.cancel(c as never);

      expect(repo.remove).toHaveBeenCalledWith('p1');
      expect(c.editMessageText).toHaveBeenCalledWith(
        expect.stringContaining('Скасовано'),
        expect.anything(),
      );
    });

    it('should not delete a draft of another chat', async () => {
      const c = press(999);

      await service.cancel(c as never);

      expect(repo.remove).not.toHaveBeenCalled();
    });
  });

  describe('askFiles', () => {
    it('should ask for the files as a reply and remember the prompt', async () => {
      const c = press();

      await service.askFiles(c as never);

      const [text, options] = c.reply.mock.calls[0] as [
        string,
        { reply_markup: { force_reply: boolean } },
      ];
      expect(text).toContain('відповіддю');
      expect(options.reply_markup.force_reply).toBe(true);
      expect(repo.remember).toHaveBeenCalledWith(555n, 90, 'p1');
    });
  });
});
