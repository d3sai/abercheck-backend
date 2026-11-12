import { Currency, Prisma } from '../../../src/generated/prisma/client';
import {
  AttachmentsService,
  type TelegramFileRef,
} from '../../../src/modules/attachments/attachments.service';
import type { Initiator } from '../../../src/modules/refunds/refund.events';

interface MediaGroupItem {
  type: string;
  media: string;
  caption?: string;
  parse_mode?: string;
}

describe('AttachmentsService.saveFromTelegram', () => {
  const ADMIN_CHAT_ID = -1001234567890;
  const prisma = {
    orderAttachment: { create: jest.fn() },
    order: { findUnique: jest.fn() },
  };
  const bot = {
    telegram: { sendDocument: jest.fn(), sendPhoto: jest.fn(), sendMediaGroup: jest.fn() },
  };
  const config = { get: jest.fn().mockReturnValue(ADMIN_CHAT_ID) };
  let service: AttachmentsService;

  const order = {
    id: 1,
    orderNumber: '0000-066717',
    baseNumber: '0000-066717',
    clientName: 'Test',
    amountDue: new Prisma.Decimal('1'),
    currency: Currency.UAH,
    exchangeRate: null,
    comment: null,
    paidAt: new Date('2026-11-11T12:53:00Z'),
  };
  const uploader: Initiator = { telegramId: 5000000000n, name: 'Христина' };

  const file = (id: string, kind: TelegramFileRef['kind'] = 'document'): TelegramFileRef => ({
    fileId: id,
    filename: `${id}.png`,
    mimeType: 'image/png',
    size: 10,
    kind,
  });

  beforeEach(() => {
    config.get.mockReturnValue(ADMIN_CHAT_ID);
    prisma.order.findUnique.mockResolvedValue(null);
    service = new AttachmentsService(prisma as never, bot as never, config as never);
    prisma.orderAttachment.create.mockImplementation(({ data }: { data: object }) =>
      Promise.resolve({ id: Math.random(), ...data }),
    );
  });

  afterEach(() => jest.resetAllMocks());

  it('should send a single file as one document message', async () => {
    bot.telegram.sendDocument.mockResolvedValue({ document: { file_id: 'f1' }, message_id: 10 });

    const attachments = await service.saveFromTelegram(order, [file('f1')], uploader, true);

    expect(bot.telegram.sendDocument).toHaveBeenCalledTimes(1);
    expect(bot.telegram.sendMediaGroup).not.toHaveBeenCalled();
    expect(attachments).toHaveLength(1);
  });

  it('should group several files into a single media-group message', async () => {
    bot.telegram.sendMediaGroup.mockResolvedValue([
      { document: { file_id: 'f1' }, message_id: 20 },
      { document: { file_id: 'f2' }, message_id: 21 },
    ]);

    const attachments = await service.saveFromTelegram(
      order,
      [file('f1'), file('f2')],
      uploader,
      true,
      'Custom caption',
    );

    expect(bot.telegram.sendDocument).not.toHaveBeenCalled();
    expect(bot.telegram.sendMediaGroup).toHaveBeenCalledTimes(1);
    const [chatId, media] = bot.telegram.sendMediaGroup.mock.calls[0] as [number, MediaGroupItem[]];
    expect(chatId).toBe(ADMIN_CHAT_ID);
    expect(media).toEqual([
      { type: 'document', media: 'f1' },
      { type: 'document', media: 'f2', caption: 'Custom caption', parse_mode: 'HTML' },
    ]);
    expect(attachments.map((a) => a.telegramMessageId)).toEqual([20, 21]);
    expect(attachments.map((a) => a.telegramFileId)).toEqual(['f1', 'f2']);
  });

  it('should fall back to the default per-file caption when none is provided', async () => {
    bot.telegram.sendMediaGroup.mockResolvedValue([
      { document: { file_id: 'f1' }, message_id: 20 },
      { document: { file_id: 'f2' }, message_id: 21 },
    ]);

    await service.saveFromTelegram(order, [file('f1'), file('f2')], uploader, true);

    const [, media] = bot.telegram.sendMediaGroup.mock.calls[0] as [number, MediaGroupItem[]];
    expect(media[0]!.caption).toBeUndefined();
    expect(media[1]!.caption).toContain('📎 <b>');
    expect(media[1]!.caption).toContain('№ 0000-066717');
    expect(media[1]!.caption).toContain('Дата оплати: 14:53 11.11.2026');
    expect(media[1]!.caption).toMatch(/Додав: Христина · \d\d:\d\d \d\d\.\d\d\.\d{4}/);
  });

  it('should send a single photo via sendPhoto, not sendDocument', async () => {
    bot.telegram.sendPhoto.mockResolvedValue({ photo: [{ file_id: 'f1' }], message_id: 10 });

    const attachments = await service.saveFromTelegram(
      order,
      [file('f1', 'photo')],
      uploader,
      true,
    );

    expect(bot.telegram.sendPhoto).toHaveBeenCalledTimes(1);
    expect(bot.telegram.sendDocument).not.toHaveBeenCalled();
    expect(attachments[0]!.telegramFileId).toBe('f1');
  });

  it('should group several photos into a photo media-group message', async () => {
    bot.telegram.sendMediaGroup.mockResolvedValue([
      { photo: [{ file_id: 'f1' }], message_id: 20 },
      { photo: [{ file_id: 'f2' }], message_id: 21 },
    ]);

    await service.saveFromTelegram(
      order,
      [file('f1', 'photo'), file('f2', 'photo')],
      uploader,
      true,
    );

    const [, media] = bot.telegram.sendMediaGroup.mock.calls[0] as [number, MediaGroupItem[]];
    expect(media.every((item) => item.type === 'photo')).toBe(true);
  });

  it('should send photos and documents as separate messages, captioning only the last one', async () => {
    bot.telegram.sendPhoto.mockResolvedValue({ photo: [{ file_id: 'f1' }], message_id: 10 });
    bot.telegram.sendDocument.mockResolvedValue({ document: { file_id: 'f2' }, message_id: 11 });

    const attachments = await service.saveFromTelegram(
      order,
      [file('f1', 'photo'), file('f2', 'document')],
      uploader,
      true,
      'Custom caption',
    );

    expect(bot.telegram.sendPhoto).toHaveBeenCalledWith(
      ADMIN_CHAT_ID,
      'f1',
      expect.objectContaining({ caption: undefined }),
    );
    expect(bot.telegram.sendDocument).toHaveBeenCalledWith(
      ADMIN_CHAT_ID,
      'f2',
      expect.objectContaining({ caption: 'Custom caption' }),
    );
    expect(attachments.map((a) => a.telegramFileId)).toEqual(['f1', 'f2']);
  });

  describe('a file added after the order notice is in the chat', () => {
    const sendOptions = () =>
      (
        bot.telegram.sendDocument.mock.calls[0] as [
          unknown,
          unknown,
          {
            caption: string;
            reply_parameters?: { message_id: number; allow_sending_without_reply: boolean };
          },
        ]
      )[2];

    beforeEach(() => {
      bot.telegram.sendDocument.mockResolvedValue({ document: { file_id: 'f1' }, message_id: 10 });
    });

    it('should reply to the notice with a short caption instead of repeating the order', async () => {
      prisma.order.findUnique.mockResolvedValue({ adminMessageId: 500, attachments: [] });

      await service.saveFromTelegram(order, [file('f1')], uploader, true);

      const options = sendOptions();
      expect(options.reply_parameters).toEqual({
        message_id: 500,
        allow_sending_without_reply: true,
      });
      expect(options.caption).toContain('№ 0000-066717');
      expect(options.caption).toContain('Христина');
      expect(options.caption).not.toContain('Сума:');
    });

    it('should reply to the first file when the notice was merged into it', async () => {
      prisma.order.findUnique.mockResolvedValue({
        adminMessageId: null,
        attachments: [{ telegramMessageId: 321 }],
      });

      await service.saveFromTelegram(order, [file('f1')], uploader, true);

      expect(sendOptions().reply_parameters?.message_id).toBe(321);
    });

    it('should keep the full caption when there is nothing to reply to', async () => {
      await service.saveFromTelegram(order, [file('f1')], uploader, true);

      expect(sendOptions().reply_parameters).toBeUndefined();
      expect(sendOptions().caption).toContain('Сума:');
    });

    it('should not look for a notice when the caller gives the caption', async () => {
      await service.saveFromTelegram(order, [file('f1')], uploader, true, 'Custom caption');

      expect(prisma.order.findUnique).not.toHaveBeenCalled();
      expect(sendOptions().reply_parameters).toBeUndefined();
    });

    it('should reply to the notice for a file uploaded from the cabinet too', async () => {
      prisma.order.findUnique.mockResolvedValue({ adminMessageId: 500, attachments: [] });
      const upload = {
        originalname: 'a.png',
        mimetype: 'image/png',
        size: 5,
        buffer: Buffer.from('x'),
      };

      await service.save(order, [upload as Express.Multer.File], uploader, true);

      expect(sendOptions().reply_parameters?.message_id).toBe(500);
    });
  });
});

describe('AttachmentsService.discardMessage', () => {
  const ADMIN_CHAT_ID = -1001234567890;
  const bot = { telegram: { deleteMessage: jest.fn() } };
  const config = { get: jest.fn().mockReturnValue(ADMIN_CHAT_ID) };
  const attachment = (keepMessageOnDelete: boolean) =>
    ({ id: 3, telegramMessageId: 77, keepMessageOnDelete }) as never;
  let service: AttachmentsService;

  beforeEach(() => {
    config.get.mockReturnValue(ADMIN_CHAT_ID);
    service = new AttachmentsService({} as never, bot as never, config as never);
  });

  afterEach(() => jest.resetAllMocks());

  it('should leave the Telegram message when keepMessageOnDelete is set', async () => {
    await service.discardMessage(attachment(true));

    expect(bot.telegram.deleteMessage).not.toHaveBeenCalled();
  });

  it('should delete the stored Telegram message otherwise', async () => {
    bot.telegram.deleteMessage.mockResolvedValue(true);

    await service.discardMessage(attachment(false));

    expect(bot.telegram.deleteMessage).toHaveBeenCalledWith(ADMIN_CHAT_ID, 77);
  });

  it('should resolve when Telegram refuses to delete the message', async () => {
    bot.telegram.deleteMessage.mockRejectedValue(new Error('message to delete not found'));

    await expect(service.discardMessage(attachment(false))).resolves.toBeUndefined();
  });
});
