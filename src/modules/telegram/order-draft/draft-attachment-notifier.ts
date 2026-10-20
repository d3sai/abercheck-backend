import { Injectable } from '@nestjs/common';
import { TELEGRAM_CAPTION_LIMIT } from '../../attachments/attachments.constants';
import { AttachmentsService, type TelegramFileRef } from '../../attachments/attachments.service';
import { PrismaService } from '../../../common/prisma/prisma.service';
import type { Manager, Order } from '../../../generated/prisma/client';
import { TelegramSender } from '../core/telegram-sender';

@Injectable()
export class DraftAttachmentNotifier {
  constructor(
    private readonly attachments: AttachmentsService,
    private readonly sender: TelegramSender,
    private readonly prisma: PrismaService,
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
        const adminMessageId = await this.sender.sendToAdmins(notice);
        if (adminMessageId !== null) {
          await this.prisma.order.update({ where: { id: order.id }, data: { adminMessageId } });
        }
      }
    }
  }
}
