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
  const prisma = { orderAttachment: { create: jest.fn() } };
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
    expect(media[1]!.caption).toContain('📎 ФОП:');
    expect(media[1]!.caption).toContain('Замовлення № 0000-066717');
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
});
