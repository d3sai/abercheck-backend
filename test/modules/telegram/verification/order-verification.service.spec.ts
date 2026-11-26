import { Test } from '@nestjs/testing';
import { kyivDateTime } from '../../../../src/common/kyiv-time';
import { PrismaService } from '../../../../src/common/prisma/prisma.service';
import { Currency, OrderStatus, Prisma } from '../../../../src/generated/prisma/client';
import { TelegramSender } from '../../../../src/modules/telegram/core/telegram-sender';
import { OrderVerificationService } from '../../../../src/modules/telegram/verification/order-verification.service';
import {
  reasonButtons,
  verifyButtons,
} from '../../../../src/modules/telegram/verification/verification.messages';

const ADMIN_CHAT = -1001234567890;
const admin = { telegramId: 1n, name: 'Ірина' };
const anyDate = expect.any(Date) as unknown as Date;
const fresh = (id: number) => ({
  id,
  verifiedAt: null,
  verifiedByName: null,
  problem: null,
  problemAt: null,
  problemByName: null,
});

describe('OrderVerificationService', () => {
  const prisma = {
    order: { findUnique: jest.fn(), findMany: jest.fn(), updateMany: jest.fn() },
  };
  const sender = {
    adminChatId: ADMIN_CHAT,
    editButtons: jest.fn(),
    sendToTopic: jest.fn(),
    send: jest.fn(),
  };
  let service: OrderVerificationService;

  const stored = (patch: Record<string, unknown> = {}) => ({
    ...fresh(7),
    verifyMessageId: 500,
    orderNumber: '0000-076454',
    clientName: 'Берчатова Л.О.',
    amountDue: new Prisma.Decimal('13309'),
    currency: Currency.UAH,
    manager: { telegramId: 9n, name: 'Діана' },
    ...patch,
  });

  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [
        OrderVerificationService,
        { provide: PrismaService, useValue: prisma },
        { provide: TelegramSender, useValue: sender },
      ],
    }).compile();
    service = moduleRef.get(OrderVerificationService);
  });

  afterEach(() => jest.resetAllMocks());

  describe('attachControls', () => {
    it('should put the buttons on the notice and remember it', async () => {
      sender.editButtons.mockResolvedValue(true);

      await service.attachControls([{ id: 7, orderNumber: 'A' }], 500);

      expect(sender.editButtons).toHaveBeenCalledWith(ADMIN_CHAT, 500, verifyButtons(fresh(7)));
      expect(sender.sendToTopic).not.toHaveBeenCalled();
      expect(prisma.order.updateMany).toHaveBeenCalledWith({
        where: { id: { in: [7] } },
        data: { verifyMessageId: 500 },
      });
    });

    it('should post «🔎 Звірка» under an album, which takes no buttons', async () => {
      sender.editButtons.mockResolvedValue(false);
      sender.sendToTopic.mockResolvedValue(501);

      await service.attachControls(
        [
          { id: 7, orderNumber: 'A' },
          { id: 8, orderNumber: 'B' },
        ],
        500,
      );

      expect(sender.sendToTopic).toHaveBeenCalledWith(
        'payments',
        '🔎 Звірка № A, B',
        verifyButtons(fresh(7)),
        { replyTo: 500 },
      );
      expect(prisma.order.updateMany).toHaveBeenCalledWith({
        where: { id: { in: [7, 8] } },
        data: { verifyMessageId: 501 },
      });
    });

    it('should post «🔎 Звірка» on its own when the notice id is unknown', async () => {
      sender.sendToTopic.mockResolvedValue(501);

      await service.attachControls([{ id: 7, orderNumber: 'A' }], null);

      expect(sender.editButtons).not.toHaveBeenCalled();
      expect(sender.sendToTopic).toHaveBeenCalledWith(
        'payments',
        '🔎 Звірка № A',
        verifyButtons(fresh(7)),
        {},
      );
    });

    it('should not throw when Telegram refuses both', async () => {
      sender.editButtons.mockResolvedValue(false);
      sender.sendToTopic.mockResolvedValue(null);

      await expect(service.attachControls([{ id: 7, orderNumber: 'A' }], 500)).resolves.toBe(
        undefined,
      );
      expect(prisma.order.updateMany).not.toHaveBeenCalled();
    });

    it('should not throw when the database fails', async () => {
      sender.editButtons.mockResolvedValue(true);
      prisma.order.updateMany.mockRejectedValue(new Error('db down'));

      await expect(service.attachControls([{ id: 7, orderNumber: 'A' }], 500)).resolves.toBe(
        undefined,
      );
    });

    it('should do nothing for no orders', async () => {
      await service.attachControls([], 500);

      expect(sender.editButtons).not.toHaveBeenCalled();
      expect(sender.sendToTopic).not.toHaveBeenCalled();
    });
  });

  describe('verify', () => {
    it('should verify every order of the card', async () => {
      prisma.order.findUnique.mockResolvedValue(stored());

      const result = await service.verify(7, admin);

      expect(prisma.order.updateMany).toHaveBeenCalledWith({
        where: { verifyMessageId: 500 },
        data: {
          verifiedAt: anyDate,
          verifiedByName: 'Ірина',
          problem: null,
          problemAt: null,
          problemByName: null,
        },
      });
      expect(result).toEqual({
        buttons: [[expect.objectContaining({ callback_data: 'vf:undo:7' })]],
      });
      expect((result as { buttons: { text: string }[][] }).buttons[0]![0]!.text).toContain(
        '✅ Звірено · Ірина',
      );
    });

    it('should verify the order alone when its buttons are not stored', async () => {
      prisma.order.findUnique.mockResolvedValue(stored({ verifyMessageId: null }));

      await service.verify(7, admin);

      expect(prisma.order.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 7 } }),
      );
    });

    it('should answer the verified state when pressed twice', async () => {
      prisma.order.findUnique.mockResolvedValue(stored());

      await service.verify(7, admin);
      const again = await service.verify(7, admin);

      expect(again).toEqual({
        buttons: [[expect.objectContaining({ callback_data: 'vf:undo:7' })]],
      });
    });

    it('should refuse an order that is gone', async () => {
      prisma.order.findUnique.mockResolvedValue(null);

      expect(await service.verify(7, admin)).toEqual({ error: '⚠️ Замовлення не знайдено' });
      expect(prisma.order.updateMany).not.toHaveBeenCalled();
    });
  });

  describe('undo', () => {
    it('should clear the verification', async () => {
      prisma.order.findUnique.mockResolvedValue(
        stored({ verifiedAt: new Date(), verifiedByName: 'Ірина' }),
      );

      const result = await service.undo(7);

      expect(prisma.order.updateMany).toHaveBeenCalledWith({
        where: { verifyMessageId: 500 },
        data: { verifiedAt: null, verifiedByName: null },
      });
      expect(result).toEqual({ buttons: verifyButtons(fresh(7)) });
    });
  });

  describe('problem', () => {
    it('should store the problem and tell the manager', async () => {
      prisma.order.findUnique.mockResolvedValue(stored());
      sender.send.mockResolvedValue(1);

      const result = await service.problem(7, ['processing'], admin);

      expect(prisma.order.updateMany).toHaveBeenCalledWith({
        where: { verifyMessageId: 500 },
        data: {
          problem: 'processing',
          problemAt: anyDate,
          problemByName: 'Ірина',
          verifiedAt: null,
          verifiedByName: null,
        },
      });
      expect(sender.send).toHaveBeenCalledWith(
        9n,
        '⚠️ Фінансист: № 0000-076454 (Берчатова Л.О., 13 309 грн): квитанція в обробці',
      );
      expect(result).toMatchObject({
        delivered: true,
        buttons: [
          [expect.objectContaining({ callback_data: 'vf:bad:7' })],
          [expect.objectContaining({ callback_data: 'vf:ok:7' })],
        ],
      });
    });

    it('should say the manager was not reached, and still show the problem', async () => {
      prisma.order.findUnique.mockResolvedValue(stored());
      sender.send.mockResolvedValue(null);

      const result = await service.problem(7, ['sum'], admin);

      expect(result).toMatchObject({ delivered: false });
      expect(result).toHaveProperty('buttons');
    });

    it('should refuse an order that is gone', async () => {
      prisma.order.findUnique.mockResolvedValue(null);

      expect(await service.problem(7, ['sum'], admin)).toEqual({
        error: '⚠️ Замовлення не знайдено',
      });
      expect(sender.send).not.toHaveBeenCalled();
    });
  });

  describe('reasons and back', () => {
    it('should list the reasons', async () => {
      prisma.order.findUnique.mockResolvedValue(stored());

      expect(await service.reasons(7)).toEqual({ buttons: reasonButtons(7, 0) });
      expect(await service.reasons(7, 3)).toEqual({ buttons: reasonButtons(7, 3) });
    });

    it('should go back to the stored state', async () => {
      prisma.order.findUnique.mockResolvedValue(
        stored({ problem: 'sum', problemAt: new Date(), problemByName: 'Ірина' }),
      );

      const result = await service.back(7);

      expect(result).toEqual({
        buttons: [
          [expect.objectContaining({ callback_data: 'vf:bad:7' })],
          [expect.objectContaining({ callback_data: 'vf:ok:7' })],
        ],
      });
    });
  });

  describe('digestItems', () => {
    it('should pick open, recent orders that have buttons', async () => {
      prisma.order.findMany.mockResolvedValue([
        { ...stored({ problem: 'sum' }), createdAt: kyivDateTime(2026, 11, 23) },
        { ...stored({ problem: 'unknown-old-code' }), createdAt: kyivDateTime(2026, 11, 23) },
      ]);

      const items = await service.digestItems(kyivDateTime(2026, 11, 24, 9, 0));

      expect(prisma.order.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            verifiedAt: null,
            verifyMessageId: { not: null },
            status: { not: OrderStatus.CANCELLED },
            createdAt: { gte: kyivDateTime(2026, 11, 10, 9, 0) },
          },
        }),
      );
      expect(items.map((item) => item.problems)).toEqual([['sum'], []]);
      expect(items[0]).toMatchObject({ managerName: 'Діана', verifyMessageId: 500 });
    });
  });
});
