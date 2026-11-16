import { Injectable, Logger } from '@nestjs/common';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Context } from 'telegraf';
import { GUIDES, GUIDES_DIR } from './guides';

@Injectable()
export class GuideService {
  private readonly logger = new Logger(GuideService.name);
  private readonly fileIds = new Map<string, string>();

  async send(ctx: Context, key: string): Promise<void> {
    const guide = GUIDES.find((item) => item.key === key);
    if (!guide) return;
    const cached = this.fileIds.get(guide.key);
    const path = join(process.cwd(), GUIDES_DIR, guide.file);
    if (!cached && !existsSync(path)) {
      this.logger.warn(`Guide video is missing: ${path}`);
      await ctx.reply('Це відео ще не додано. Зверніться до адміністратора.');
      return;
    }
    const sent = await ctx.replyWithVideo(cached ?? { source: path }, {
      caption: guide.title,
      supports_streaming: true,
    });
    this.fileIds.set(guide.key, sent.video.file_id);
  }
}
