import { Logger } from '@nestjs/common';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GuideService } from '../../../../src/modules/telegram/guides/guide.service';
import { GUIDES_MENU } from '../../../../src/modules/telegram/guides/guides';

describe('GuideService', () => {
  let root: string;
  let service: GuideService;
  let warn: jest.SpyInstance;
  const ctx = () => ({
    reply: jest.fn(),
    replyWithVideo: jest.fn().mockResolvedValue({ video: { file_id: 'tg-file-1' } }),
  });

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'guides-'));
    mkdirSync(join(root, 'guides'));
    writeFileSync(join(root, 'guides', 'novyi-zapyt.mp4'), 'video');
    jest.spyOn(process, 'cwd').mockReturnValue(root);
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    service = new GuideService();
  });
  afterEach(() => {
    jest.restoreAllMocks();
    rmSync(root, { recursive: true, force: true });
  });

  it('should offer a button for every guide', () => {
    expect(GUIDES_MENU.buttons!.flat().map((b) => 'callback_data' in b && b.callback_data)).toEqual(
      ['guide:request', 'guide:answer', 'guide:cancel'],
    );
  });

  it('should upload the video from the guides folder once, then resend it by its Telegram id', async () => {
    const first = ctx();
    const second = ctx();

    await service.send(first as never, 'request');
    await service.send(second as never, 'request');

    expect(first.replyWithVideo).toHaveBeenCalledWith(
      { source: join(root, 'guides', 'novyi-zapyt.mp4') },
      expect.objectContaining({
        caption: '📝 Як створити запит фінансисту',
        supports_streaming: true,
      }),
    );
    expect(second.replyWithVideo).toHaveBeenCalledWith('tg-file-1', expect.anything());
  });

  it('should say the video is not there yet when its file is missing', async () => {
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
    expect(c.reply).not.toHaveBeenCalled();
  });
});
