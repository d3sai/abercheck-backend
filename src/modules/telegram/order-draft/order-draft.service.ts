import { Injectable, type OnApplicationShutdown } from '@nestjs/common';
import {
  ALLOWED_MIME_TYPES,
  MAX_FILES_PER_UPLOAD,
  MAX_FILE_SIZE_BYTES,
} from '../../attachments/attachments.constants';
import type { TelegramFileRef } from '../../attachments/attachments.service';
import type { Manager, OrderType } from '../../../generated/prisma/client';
import { BOT_RESTART_NOTICE, type BotReply } from '../core/bot-reply';
import { escapeHtml } from '../core/format';
import { TelegramSender } from '../core/telegram-sender';
import { DraftAction } from './draft-action';
import { OrderCreationFlow } from './order-creation.flow';
import { PartOfferStore } from './part-offer.store';
import { PendingFilesStore } from './pending-files.store';
import { multipleOrRequisitesGuard } from './requisites.messages';
import { RequisitesDraftService } from './requisites-draft.service';

export { DraftAction };

// Coordinates the two order-draft flows — the regular single-order template (OrderCreationFlow)
// and the "кілька номерів / реквізити" mode (RequisitesDraftService) — plus the file buffer they
// share: which one a message or upload goes to depends on whether the requisites mode is armed.
@Injectable()
export class OrderDraftService implements OnApplicationShutdown {
  constructor(
    private readonly orderCreation: OrderCreationFlow,
    private readonly requisitesFlow: RequisitesDraftService,
    private readonly pendingFiles: PendingFilesStore,
    private readonly partOffers: PartOfferStore,
    private readonly sender: TelegramSender,
  ) {}

  // The bot is restarting: whoever has files waiting, an unanswered part offer, or an armed/pending
  // requisites flow would otherwise lose it silently. A short warning at least makes that visible.
  async onApplicationShutdown(): Promise<void> {
    const now = Date.now();
    const ids = new Set<bigint>([
      ...this.pendingFiles.pendingUserIds(),
      ...this.partOffers.pendingUserIds(now),
      ...this.requisitesFlow.pendingUserIds(now),
    ]);
    await Promise.all([...ids].map((id) => this.sender.send(id, BOT_RESTART_NOTICE)));
  }

  hint(type: OrderType): BotReply {
    return this.orderCreation.hint(type);
  }

  // Arms the "кілька номерів / реквізити" mode: only while it's armed does the very next message go
  // through the requisites parser instead of the regular single-order template.
  startRequisites(userId: bigint): BotReply {
    return this.requisitesFlow.start(userId);
  }

  async handleText(manager: Manager, text: string): Promise<BotReply | null> {
    if (this.requisitesFlow.isArmed(manager.telegramId)) {
      return this.requisitesFlow.handle(manager, text);
    }
    if (this.orderCreation.needsRequisitesButton(text)) {
      return multipleOrRequisitesGuard();
    }
    const raw = this.orderCreation.extractFields(text);
    if (!raw) {
      return this.orderCreation.nudge(manager.telegramId);
    }
    return this.orderCreation.process(manager, raw);
  }

  async addFile(manager: Manager, file: TelegramFileRef, caption?: string): Promise<BotReply> {
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
    if (!text) {
      return {
        html: `📎 Додано «${escapeHtml(file.filename)}» (${files.length}/${MAX_FILES_PER_UPLOAD}).`,
      };
    }
    if (this.requisitesFlow.isArmed(manager.telegramId)) {
      return this.requisitesFlow.handle(manager, text);
    }
    if (this.orderCreation.needsRequisitesButton(text)) {
      return multipleOrRequisitesGuard();
    }
    const raw = this.orderCreation.extractFields(text);
    if (raw) {
      return this.orderCreation.process(manager, raw);
    }
    return {
      html: `📎 Додано «${escapeHtml(file.filename)}» (${files.length}/${MAX_FILES_PER_UPLOAD}).`,
    };
  }

  cancel(userId: bigint): BotReply {
    const hadFiles = this.pendingFiles.clear(userId);
    const hadOffer = this.partOffers.delete(userId);
    const hadRequisites = this.requisitesFlow.clear(userId);
    return {
      html: hadFiles || hadOffer || hadRequisites ? 'Скасовано.' : 'Нема чого скасовувати.',
    };
  }

  // Another flow was started: the next message is no longer a requisites report, and any pending
  // preview is dropped.
  leaveRequisites(userId: bigint): void {
    this.requisitesFlow.leave(userId);
  }

  editRequisites(userId: bigint): BotReply {
    return this.requisitesFlow.edit(userId);
  }

  // "Це звичайне замовлення" escape hatch: the message was misread as a requisites report, so the
  // same text goes through the regular template instead.
  async regularFromRequisites(manager: Manager): Promise<BotReply> {
    return this.requisitesFlow.regularFrom(manager);
  }

  async confirmRequisites(manager: Manager): Promise<BotReply> {
    return this.requisitesFlow.confirm(manager);
  }

  async addPart(manager: Manager): Promise<BotReply> {
    const offer = this.partOffers.take(manager.telegramId);
    if (!offer || offer.expiresAt < Date.now()) {
      return { html: '⚠️ Немає даних для додавання. Надішліть замовлення ще раз.' };
    }
    return this.orderCreation.createOrder(manager, offer.data, true);
  }

  skipPart(userId: bigint): BotReply {
    this.partOffers.delete(userId);
    return { html: 'Скасовано.' };
  }
}
