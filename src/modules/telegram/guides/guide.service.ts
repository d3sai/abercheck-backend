import { Injectable, Logger } from '@nestjs/common';
import { statSync } from 'node:fs';
import { join } from 'node:path';
import type { Context } from 'telegraf';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { GUIDES, GUIDES_DIR } from './guides';

@Injectable()
export class GuideService {
  private readonly logger = new Logger(GuideService.name);

  constructor(private readonly prisma: PrismaService) {}

  async send(ctx: Context, key: string): Promise<void> {
    const guide = GUIDES.find((item) => item.key === key);
    if (!guide) return;
    const path = join(process.cwd(), GUIDES_DIR, guide.file);
    const stat = statSync(path, { throwIfNoEntry: false });
    const stored = await this.prisma.guideVideo.findUnique({ where: { key: guide.key } });
    const options = { caption: guide.title, supports_streaming: true };

    if (
      stored &&
      (!stat ||
        (stored.fileSize === stat.size && stored.fileMtime.getTime() === stat.mtime.getTime()))
    ) {
      await ctx.replyWithVideo(stored.fileId, options);
      return;
    }
    if (!stat) {
      this.logger.warn(`Guide video is missing: ${path}`);
      await ctx.reply('Це відео ще не додано. Зверніться до адміністратора.');
      return;
    }
    const sent = await ctx.replyWithVideo({ source: path }, options);
    const stamp = { fileId: sent.video.file_id, fileSize: stat.size, fileMtime: stat.mtime };
    await this.prisma.guideVideo.upsert({
      where: { key: guide.key },
      create: { key: guide.key, ...stamp },
      update: stamp,
    });
  }
}
