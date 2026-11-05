import { Injectable } from '@nestjs/common';
import type { FinanceRequestCard, FinanceRequestFile, Prisma } from '../../generated/prisma/client';
import { isUniqueViolation } from '../../common/prisma/prisma-errors';
import { PrismaService } from '../../common/prisma/prisma.service';
import type { TelegramFileRef } from '../attachments/attachments.service';

export type NewRequestCard = Prisma.FinanceRequestCardUncheckedCreateInput;

@Injectable()
export class RequestCardsRepository {
  constructor(private readonly prisma: PrismaService) {}

  create(card: NewRequestCard): Promise<FinanceRequestCard> {
    return this.prisma.financeRequestCard.create({ data: card });
  }

  byRequestId(requestId: string): Promise<FinanceRequestCard | null> {
    return this.prisma.financeRequestCard.findUnique({ where: { requestId } });
  }

  /** «Мої запити»: the manager's latest cards, newest first. */
  latestOfManager(managerChatId: bigint, take: number): Promise<FinanceRequestCard[]> {
    return this.prisma.financeRequestCard.findMany({
      where: { managerChatId },
      orderBy: { createdAt: 'desc' },
      take,
    });
  }

  byGroupMessage(groupChatId: bigint, groupMessageId: number): Promise<FinanceRequestCard | null> {
    return this.prisma.financeRequestCard.findUnique({
      where: { groupChatId_groupMessageId: { groupChatId, groupMessageId } },
    });
  }

  byManagerMessage(
    managerChatId: bigint,
    managerMessageId: number,
  ): Promise<FinanceRequestCard | null> {
    return this.prisma.financeRequestCard.findFirst({ where: { managerChatId, managerMessageId } });
  }

  setManagerMessage(requestId: string, managerMessageId: number): Promise<FinanceRequestCard> {
    return this.prisma.financeRequestCard.update({
      where: { requestId },
      data: { managerMessageId },
    });
  }

  /** True only for the one caller that completes the request; everyone else must not create orders. */
  async claimCompletion(requestId: string, now: Date): Promise<boolean> {
    const { count } = await this.prisma.financeRequestCard.updateMany({
      where: { requestId, completedAt: null },
      data: { completedAt: now },
    });
    return count > 0;
  }

  /** Only while no order exists: with orders the claim must stay, or a retry would duplicate them. */
  async releaseCompletion(requestId: string): Promise<void> {
    await this.prisma.financeRequestCard.updateMany({
      where: { requestId },
      data: { completedAt: null },
    });
  }

  setOrderIds(requestId: string, orderIds: number[]): Promise<FinanceRequestCard> {
    return this.prisma.financeRequestCard.update({ where: { requestId }, data: { orderIds } });
  }

  /** True only for the caller that changed the status, so concurrent duplicates notify once. */
  async markNotified(requestId: string, status: string): Promise<boolean> {
    // `not` alone skips NULL rows in SQL, so a never-notified card needs the explicit null branch.
    const { count } = await this.prisma.financeRequestCard.updateMany({
      where: { requestId, OR: [{ notifiedStatus: null }, { notifiedStatus: { not: status } }] },
      data: { notifiedStatus: status },
    });
    return count > 0;
  }

  /** Undo `markNotified` after a failed send, unless a newer status has replaced it. */
  async resetNotified(requestId: string, status: string): Promise<void> {
    await this.prisma.financeRequestCard.updateMany({
      where: { requestId, notifiedStatus: status },
      data: { notifiedStatus: null },
    });
  }

  /** False when the finance message was already seen. */
  async markSeen(messageId: string): Promise<boolean> {
    try {
      await this.prisma.financeMessageSeen.create({ data: { messageId } });
      return true;
    } catch (error) {
      if (isUniqueViolation(error)) return false;
      throw error;
    }
  }

  /** Undo `markSeen` after a failed delivery, so finance's retry delivers the message. */
  async unmarkSeen(messageId: string): Promise<void> {
    await this.prisma.financeMessageSeen.deleteMany({ where: { messageId } });
  }

  /** Telegram does not nest `reply_to_message`, so a bot message the manager may answer maps back here. */
  async rememberChatMessage(chatId: bigint, messageId: number, requestId: string): Promise<void> {
    await this.prisma.financeChatMessage.upsert({
      where: { chatId_messageId: { chatId, messageId } },
      create: { chatId, messageId, requestId },
      update: { requestId },
    });
  }

  async requestOfChatMessage(chatId: bigint, messageId: number): Promise<string | null> {
    const row = await this.prisma.financeChatMessage.findUnique({
      where: { chatId_messageId: { chatId, messageId } },
    });
    return row?.requestId ?? null;
  }

  /** A receipt sent before the request is completed; it waits here for the order. */
  holdFile(requestId: string, file: TelegramFileRef): Promise<FinanceRequestFile> {
    return this.prisma.financeRequestFile.create({ data: { requestId, ...file } });
  }

  heldFiles(requestId: string): Promise<FinanceRequestFile[]> {
    return this.prisma.financeRequestFile.findMany({
      where: { requestId },
      orderBy: { id: 'asc' },
    });
  }

  async deleteHeldFiles(ids: number[]): Promise<void> {
    await this.prisma.financeRequestFile.deleteMany({ where: { id: { in: ids } } });
  }
}
