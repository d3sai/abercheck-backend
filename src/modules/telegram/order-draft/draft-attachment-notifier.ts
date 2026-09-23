import { Injectable } from '@nestjs/common';
import { TELEGRAM_CAPTION_LIMIT } from '../../attachments/attachments.constants';
import { AttachmentsService, type TelegramFileRef } from '../../attachments/attachments.service';
import type { Manager, Order } from '../../../generated/prisma/client';
import { TelegramSender } from '../core/telegram-sender';

// Merges an order's admin notice into the files' caption where it fits, so admins get one message
// instead of two; falls back to sending the notice on its own when it doesn't fit or storing fails.
@Injectable()
export class DraftAttachmentNotifier {
  constructor(
    private readonly attachments: AttachmentsService,
    private readonly sender: TelegramSender,
  ) {}

  async notify(
    order: Order,
    manager: Manager,
    files: TelegramFileRef[],
    notice: string,
  ): Promise<void> {
    const canMergeCaption = notice.length <= TELEGRAM_CAPTION_LIMIT;
    let merged = false;
    try {
      await this.attachments.saveFromTelegram(
        order,
        files,
        { telegramId: manager.telegramId, name: manager.name },
        true,
        canMergeCaption ? notice : undefined,
      );
      merged = canMergeCaption;
    } finally {
      if (!merged) {
        await this.sender.sendToAdmins(notice);
      }
    }
  }
}
