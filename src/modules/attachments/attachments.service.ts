import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectBot } from 'nestjs-telegraf';
import { Telegraf } from 'telegraf';
import type { Convenience, Message } from 'telegraf/types';
import type { EnvironmentVariables } from '../../common/config/env.validation';
import type { Order, OrderAttachment } from '../../generated/prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import type { Initiator } from '../refunds/refund.events';
import { escapeHtml, formatMoneyIn } from '../telegram/core/format';
import { AttachmentNotFoundError, AttachmentStorageError } from './attachments.errors';

type CaptionOrder = Pick<Order, 'orderNumber' | 'clientName' | 'amountDue' | 'currency'>;

export interface TelegramFileRef {
  fileId: string;
  filename: string;
  mimeType: string;
  size: number;
  kind: 'photo' | 'document';
}

type SentMedia = Message.DocumentMessage | Message.PhotoMessage;

function fileIdOf(sent: SentMedia): string {
  return 'document' in sent ? sent.document.file_id : sent.photo[sent.photo.length - 1]!.file_id;
}

function caption(order: CaptionOrder, uploader: Initiator): string {
  return [
    `📎 ФОП: <b>${escapeHtml(order.clientName)}</b>`,
    `Замовлення № ${escapeHtml(order.orderNumber)}`,
    `Сума до оплати: ${formatMoneyIn(order.amountDue, order.currency)}`,
    `Додав: ${escapeHtml(uploader.name)}`,
  ].join('\n');
}

@Injectable()
export class AttachmentsService {
  private readonly logger = new Logger(AttachmentsService.name);
  private readonly storageChatId: number;

  constructor(
    private readonly prisma: PrismaService,
    @InjectBot() private readonly bot: Telegraf,
    config: ConfigService<EnvironmentVariables, true>,
  ) {
    this.storageChatId = config.get('TELEGRAM_ADMIN_CHAT_ID', { infer: true });
  }

  async save(
    order: CaptionOrder & { id: number },
    files: Express.Multer.File[],
    uploader: Initiator,
    keepMessageOnDelete: boolean,
  ): Promise<OrderAttachment[]> {
    const attachments: OrderAttachment[] = [];
    for (const file of files) {
      attachments.push(
        await this.store(
          order,
          uploader,
          keepMessageOnDelete,
          { filename: file.originalname, mimeType: file.mimetype, size: file.size },
          () =>
            this.bot.telegram.sendDocument(
              this.storageChatId,
              { source: file.buffer, filename: file.originalname },
              { caption: caption(order, uploader), parse_mode: 'HTML' },
            ),
        ),
      );
    }
    return attachments;
  }

  async saveFromTelegram(
    order: CaptionOrder & { id: number },
    files: TelegramFileRef[],
    uploader: Initiator,
    keepMessageOnDelete: boolean,
    groupCaption?: string,
  ): Promise<OrderAttachment[]> {
    if (files.length === 0) {
      return [];
    }

    const groups = (['photo', 'document'] as const)
      .map((kind) => ({ kind, files: files.filter((f) => f.kind === kind) }))
      .filter((group) => group.files.length > 0);

    const attachments: OrderAttachment[] = [];
    for (const [index, group] of groups.entries()) {
      const captionText =
        index === groups.length - 1 ? (groupCaption ?? caption(order, uploader)) : undefined;
      attachments.push(
        ...(await this.saveGroup(
          order,
          uploader,
          keepMessageOnDelete,
          group.kind,
          group.files,
          captionText,
        )),
      );
    }
    return attachments;
  }

  private async saveGroup(
    order: CaptionOrder & { id: number },
    uploader: Initiator,
    keepMessageOnDelete: boolean,
    kind: 'photo' | 'document',
    files: TelegramFileRef[],
    captionText: string | undefined,
  ): Promise<OrderAttachment[]> {
    if (files.length === 1) {
      const file = files[0]!;
      return [
        await this.store(order, uploader, keepMessageOnDelete, file, () =>
          kind === 'photo'
            ? this.bot.telegram.sendPhoto(this.storageChatId, file.fileId, {
                caption: captionText,
                parse_mode: 'HTML',
              })
            : this.bot.telegram.sendDocument(this.storageChatId, file.fileId, {
                caption: captionText,
                parse_mode: 'HTML',
              }),
        ),
      ];
    }

    // One album message; the caption sits on the last file so it reads as a trailing note below the whole stack.
    const media = files.map((file, index) => ({
      type: kind,
      media: file.fileId,
      ...(index === files.length - 1 && captionText
        ? { caption: captionText, parse_mode: 'HTML' as const }
        : {}),
    })) as unknown as Convenience.MediaGroup;
    let sent: SentMedia[];
    try {
      sent = (await this.bot.telegram.sendMediaGroup(this.storageChatId, media)) as SentMedia[];
    } catch (error) {
      this.logger.error(`Failed to store attachments for order #${order.id} in Telegram`, error);
      throw new AttachmentStorageError(error);
    }

    return Promise.all(
      files.map((file, index) =>
        this.record(order, uploader, keepMessageOnDelete, file, sent[index]!),
      ),
    );
  }

  private async store(
    order: CaptionOrder & { id: number },
    uploader: Initiator,
    keepMessageOnDelete: boolean,
    meta: Pick<TelegramFileRef, 'filename' | 'mimeType' | 'size'>,
    send: () => Promise<SentMedia>,
  ): Promise<OrderAttachment> {
    let sent: SentMedia;
    try {
      sent = await send();
    } catch (error) {
      this.logger.error(`Failed to store an attachment for order #${order.id} in Telegram`, error);
      throw new AttachmentStorageError(error);
    }
    return this.record(order, uploader, keepMessageOnDelete, meta, sent);
  }

  private record(
    order: CaptionOrder & { id: number },
    uploader: Initiator,
    keepMessageOnDelete: boolean,
    meta: Pick<TelegramFileRef, 'filename' | 'mimeType' | 'size'>,
    sent: SentMedia,
  ): Promise<OrderAttachment> {
    return this.prisma.orderAttachment.create({
      data: {
        orderId: order.id,
        filename: meta.filename,
        mimeType: meta.mimeType,
        size: meta.size,
        telegramFileId: fileIdOf(sent),
        telegramMessageId: sent.message_id,
        uploadedByTelegramId: uploader.telegramId,
        uploadedByName: uploader.name,
        keepMessageOnDelete,
      },
    });
  }

  list(orderId: number): Promise<OrderAttachment[]> {
    return this.prisma.orderAttachment.findMany({
      where: { orderId },
      orderBy: { createdAt: 'desc' },
    });
  }

  async find(orderId: number, id: number): Promise<OrderAttachment> {
    const attachment = await this.prisma.orderAttachment.findFirst({ where: { id, orderId } });
    if (!attachment) {
      throw new AttachmentNotFoundError(id);
    }
    return attachment;
  }

  async readFile(attachment: OrderAttachment): Promise<Buffer> {
    let url: URL;
    try {
      url = await this.bot.telegram.getFileLink(attachment.telegramFileId);
    } catch (error) {
      throw new AttachmentStorageError(error);
    }
    const response = await fetch(url);
    if (!response.ok) {
      throw new AttachmentStorageError(
        new Error(`Telegram file download responded ${response.status}`),
      );
    }
    return Buffer.from(await response.arrayBuffer());
  }

  async remove(orderId: number, id: number): Promise<void> {
    const attachment = await this.find(orderId, id);
    await this.prisma.orderAttachment.delete({ where: { id: attachment.id } });
    if (attachment.keepMessageOnDelete) {
      return;
    }
    await this.bot.telegram
      .deleteMessage(this.storageChatId, attachment.telegramMessageId)
      .catch((error) =>
        this.logger.warn(`Failed to delete Telegram message for attachment #${id}`, error),
      );
  }
}
