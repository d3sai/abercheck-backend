import { Injectable, type OnApplicationShutdown } from '@nestjs/common';
import {
  ALLOWED_MIME_TYPES,
  MAX_FILES_PER_UPLOAD,
  MAX_FILE_SIZE_BYTES,
} from '../../attachments/attachments.constants';
import type { TelegramFileRef } from '../../attachments/attachments.service';
import type { Manager } from '../../../generated/prisma/client';
import { BOT_RESTART_NOTICE, type BotReply } from '../core/bot-reply';
import { escapeHtml } from '../core/format';
import { TelegramSender } from '../core/telegram-sender';
import { CashDraftService } from './cash-draft.service';
import { ForeignDraftService } from './foreign-draft.service';
import { KitDraftService } from './kit-draft.service';
import { PendingFilesStore } from './pending-files.store';

@Injectable()
export class OrderDraftService implements OnApplicationShutdown {
  constructor(
    private readonly kitFlow: KitDraftService,
    private readonly cashFlow: CashDraftService,
    private readonly foreignFlow: ForeignDraftService,
    private readonly pendingFiles: PendingFilesStore,
    private readonly sender: TelegramSender,
  ) {}

  async onApplicationShutdown(): Promise<void> {
    const now = Date.now();
    const ids = new Set<bigint>([
      ...this.pendingFiles.pendingUserIds(),
      ...this.modes.flatMap((mode) => mode.pendingUserIds(now)),
    ]);
    await Promise.all([...ids].map((id) => this.sender.send(id, BOT_RESTART_NOTICE)));
  }

  startKit(userId: bigint): BotReply {
    return this.switchTo(userId, this.kitFlow);
  }

  startCash(userId: bigint): BotReply {
    return this.switchTo(userId, this.cashFlow);
  }

  startForeign(userId: bigint): BotReply {
    return this.switchTo(userId, this.foreignFlow);
  }

  // null outside an armed mode: the caller shows the help instead.
  async handleText(manager: Manager, text: string): Promise<BotReply | null> {
    const armed = this.modes.find((mode) => mode.isArmed(manager.telegramId));
    return armed ? armed.handle(manager, text) : null;
  }

  async addFile(
    manager: Manager,
    file: TelegramFileRef,
    caption?: string,
  ): Promise<BotReply | null> {
    if (!this.modes.some((mode) => mode.isArmed(manager.telegramId))) {
      return null;
    }
    if (!ALLOWED_MIME_TYPES.has(file.mimeType)) {
      return { html: '⚠️ Такий тип файлу не підтримується. Додайте фото, PDF або зображення.' };
    }
    if (file.size > MAX_FILE_SIZE_BYTES) {
      return { html: '⚠️ Файл завеликий. Максимум 10 МБ.' };
    }
    if (this.pendingFiles.list(manager.telegramId).length >= MAX_FILES_PER_UPLOAD) {
      return { html: `⚠️ Максимум ${MAX_FILES_PER_UPLOAD} файлів на замовлення.` };
    }

    const files = this.pendingFiles.add(manager.telegramId, file);
    const text = caption?.trim();
    const answer = text ? await this.handleText(manager, text) : null;
    return (
      answer ?? {
        html: `📎 Додано «${escapeHtml(file.filename)}» (${files.length}/${MAX_FILES_PER_UPLOAD}).`,
      }
    );
  }

  cancel(userId: bigint): BotReply {
    const hadFiles = this.pendingFiles.clear(userId);
    const hadMode = this.leaveModes(userId);
    return { html: hadFiles || hadMode ? 'Скасовано.' : 'Нема чого скасовувати.' };
  }

  editCash(userId: bigint): BotReply {
    return this.cashFlow.edit(userId);
  }

  async confirmCash(manager: Manager): Promise<BotReply> {
    return this.cashFlow.confirm(manager);
  }

  editForeign(userId: bigint): BotReply {
    return this.foreignFlow.edit(userId);
  }

  async confirmForeign(manager: Manager): Promise<BotReply> {
    return this.foreignFlow.confirm(manager);
  }

  editKit(userId: bigint): BotReply {
    return this.kitFlow.edit(userId);
  }

  async confirmKit(manager: Manager): Promise<BotReply> {
    return this.kitFlow.confirm(manager);
  }

  private get modes() {
    return [this.kitFlow, this.cashFlow, this.foreignFlow];
  }

  private leaveModes(userId: bigint): boolean {
    return this.modes.map((mode) => mode.leave(userId)).some(Boolean);
  }

  private switchTo(userId: bigint, mode: { start(userId: bigint): BotReply }): BotReply {
    this.leaveModes(userId);
    return mode.start(userId);
  }
}
