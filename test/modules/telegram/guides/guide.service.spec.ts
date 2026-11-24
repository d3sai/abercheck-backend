import { Logger } from '@nestjs/common';
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GuideService } from '../../../../src/modules/telegram/guides/guide.service';
import { GUIDES_MENU } from '../../../../src/modules/telegram/guides/guides';

describe('GuideService', () => {
  let root: string;
  let file: string;
  let service: GuideService;
  let warn: jest.SpyInstance;
  const prisma = { guideVideo: { findUnique: jest.fn(), upsert: jest.fn() } };
  const ctx = () => ({
    reply: jest.fn(),
    replyWithVideo: jest.fn().mockResolvedValue({ video: { file_id: 'tg-new' } }),
  });
  const stored = (patch: Record<string, unknown> = {}) => {
    const stat = statSync(file);
    return {
      key: 'request',
      fileId: 'tg-old',
      fileSize: stat.size,
      fileMtime: stat.mtime,
      ...patch,
    };
  };

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'guides-'));
    mkdirSync(join(root, 'guides'));
    file = join(root, 'guides', 'novyi-zapyt.mp4');
    writeFileSync(file, 'video');
    jest.spyOn(process, 'cwd').mockReturnValue(root);
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    prisma.guideVideo.findUnique.mockResolvedValue(null);
    service = new GuideService(prisma as never);
  });
  afterEach(() => {
    jest.resetAllMocks();
    jest.restoreAllMocks();
    rmSync(root, { recursive: true, force: true });
  });

  it('should offer a button for every guide', () => {
    expect(GUIDES_MENU.buttons!.flat().map((b) => 'callback_data' in b && b.callback_data)).toEqual(
      ['guide:request', 'guide:answer', 'guide:cancel'],
    );
  });

  it('should upload a video it has never sent and store its Telegram id with the file stamp', async () => {
    const c = ctx();

    await service.send(c as never, 'request');

    expect(c.replyWithVideo).toHaveBeenCalledWith(
      { source: file },
      expect.objectContaining({
        caption: '📝 Як створити запит фінансисту',
        supports_streaming: true,
        width: 1920,
        height: 1080,
      }),
    );
    const { fileSize, fileMtime } = stored();
    expect(prisma.guideVideo.upsert).toHaveBeenCalledWith({
      where: { key: 'request' },
      create: { key: 'request', fileId: 'tg-new', fileSize, fileMtime },
      update: { fileId: 'tg-new', fileSize, fileMtime },
    });
  });

  it('should resend a stored video by its Telegram id while the file is unchanged', async () => {
    prisma.guideVideo.findUnique.mockResolvedValue(stored());
    const c = ctx();

    await service.send(c as never, 'request');

    expect(c.replyWithVideo).toHaveBeenCalledWith('tg-old', expect.anything());
    expect(prisma.guideVideo.upsert).not.toHaveBeenCalled();
  });

  it('should upload again once the file on the server was replaced', async () => {
    prisma.guideVideo.findUnique.mockResolvedValue(stored({ fileSize: 1 }));
    const c = ctx();

    await service.send(c as never, 'request');

    expect(c.replyWithVideo).toHaveBeenCalledWith({ source: file }, expect.anything());
    expect(prisma.guideVideo.upsert).toHaveBeenCalled();
  });

  it('should still resend a stored video whose file is gone from the server', async () => {
    prisma.guideVideo.findUnique.mockResolvedValue(stored({ key: 'cancel' }));
    const c = ctx();

    await service.send(c as never, 'cancel');

    expect(c.replyWithVideo).toHaveBeenCalledWith('tg-old', expect.anything());
  });

  it('should say the video is not there yet when it was never sent and its file is missing', async () => {
    const c = ctx();

    await service.send(c as never, 'cancel');

    expect(c.replyWithVideo).not.toHaveBeenCalled();
    expect(c.reply).toHaveBeenCalledWith('Це відео ще не додано. Зверніться до адміністратора.');
    expect(warn).toHaveBeenCalled();
  });

  it('should ignore an unknown guide', async () => {
    const c = ctx();

    await service.send(c as never, 'nope');

    expect(c.replyWithVideo).not.toHaveBeenCalled();
    expect(prisma.guideVideo.findUnique).not.toHaveBeenCalled();
  });
});
