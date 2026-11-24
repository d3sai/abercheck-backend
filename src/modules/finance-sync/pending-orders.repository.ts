import { Injectable } from '@nestjs/common';
import { isRecordNotFound } from '../../common/prisma/prisma-errors';
import { PrismaService } from '../../common/prisma/prisma.service';
import type { PendingOrder, Prisma } from '../../generated/prisma/client';
import type { TelegramFileRef } from '../attachments/attachments.service';

/** The column is only ever written by us; a malformed value counts as no files. */
export function storedFiles(value: unknown): TelegramFileRef[] {
  return Array.isArray(value)
    ? value.filter(
        (file): file is TelegramFileRef =>
          typeof file === 'object' &&
          file !== null &&
          typeof (file as TelegramFileRef).fileId === 'string',
      )
    : [];
}

/** The order numbers of a stored plan, read as the JSON it is: Kit has several, cash and foreign one. */
export function draftNumbers(value: unknown): string[] {
  const plan = (value as { plan?: { number?: unknown; items?: { number?: unknown }[] } } | null)
    ?.plan;
  if (!plan) return [];
  const numbers = plan.items ? plan.items.map((item) => item.number) : [plan.number];
  return numbers.filter((number): number is string => typeof number === 'string');
}

/** Drafts of Kit, cash and foreign orders waiting in a manager's chat for files and «Прийняти». */
@Injectable()
export class PendingOrdersRepository {
  constructor(private readonly prisma: PrismaService) {}

  create(data: {
    managerId: number;
    managerChatId: bigint;
    plan: Prisma.InputJsonValue;
  }): Promise<PendingOrder> {
    return this.prisma.pendingOrder.create({ data });
  }

  /** A manager's drafts a loose file can still go to. */
  openOfManager(managerId: number): Promise<PendingOrder[]> {
    return this.prisma.pendingOrder.findMany({
      where: { managerId },
      orderBy: { createdAt: 'desc' },
      take: 6,
    });
  }

  byId(id: string): Promise<PendingOrder | null> {
    return this.prisma.pendingOrder.findUnique({ where: { id } });
  }

  async setMessage(id: string, managerMessageId: number): Promise<void> {
    await this.prisma.pendingOrder.update({ where: { id }, data: { managerMessageId } });
  }

  /** One statement, so the files of an album that arrive together are all kept. */
  async addFile(
    id: string,
    file: TelegramFileRef,
    max: number,
  ): Promise<'added' | 'full' | 'gone'> {
    const count = await this.prisma.$executeRaw`
      UPDATE "pending_orders"
      SET "files" = "files" || ${JSON.stringify([file])}::jsonb
      WHERE "id" = ${id} AND jsonb_array_length("files") < ${max}`;
    if (count > 0) return 'added';
    return (await this.byId(id)) ? 'full' : 'gone';
  }

  /** Telegram does not nest `reply_to_message`, so a bot prompt the manager may answer maps back here. */
  async remember(chatId: bigint, messageId: number, id: string): Promise<void> {
    await this.prisma.financeChatMessage.upsert({
      where: { chatId_messageId: { chatId, messageId } },
      create: { chatId, messageId, requestId: id },
      update: { requestId: id },
    });
  }

  /** The draft a message of the manager's chat belongs to: its card, or a prompt remembered for it. */
  async idOfMessage(chatId: bigint, messageId: number): Promise<string | null> {
    const card = await this.prisma.pendingOrder.findFirst({
      where: { managerChatId: chatId, managerMessageId: messageId },
    });
    if (card) return card.id;
    const remembered = await this.prisma.financeChatMessage.findUnique({
      where: { chatId_messageId: { chatId, messageId } },
    });
    if (!remembered) return null;
    return (await this.byId(remembered.requestId))?.id ?? null;
  }

  /** The row goes to the one caller that deletes it; everyone else gets null. */
  async claim(id: string): Promise<PendingOrder | null> {
    try {
      return await this.prisma.pendingOrder.delete({ where: { id } });
    } catch (error) {
      if (isRecordNotFound(error)) return null;
      throw error;
    }
  }

  /** Undo `claim` when the order could not be made, so the manager can press again. */
  async restore(row: PendingOrder): Promise<void> {
    await this.prisma.pendingOrder.create({
      data: {
        ...row,
        plan: row.plan as Prisma.InputJsonValue,
        files: row.files as Prisma.InputJsonValue,
      },
    });
  }

  async remove(id: string): Promise<void> {
    await this.prisma.pendingOrder.deleteMany({ where: { id } });
  }
}
