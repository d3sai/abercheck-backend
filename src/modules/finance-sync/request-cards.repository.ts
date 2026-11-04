import { Injectable } from '@nestjs/common';
import type { FinanceRequestCard, Prisma } from '../../generated/prisma/client';
import { isUniqueViolation } from '../../common/prisma/prisma-errors';
import { PrismaService } from '../../common/prisma/prisma.service';

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

  byGroupMessage(groupChatId: bigint, groupMessageId: number): Promise<FinanceRequestCard | null> {
    return this.prisma.financeRequestCard.findUnique({
      where: { groupChatId_groupMessageId: { groupChatId, groupMessageId } },
    });
  }

  /** For a force-reply prompt, which only names the request number. */
  byNumber(groupChatId: bigint, number: string): Promise<FinanceRequestCard | null> {
    return this.prisma.financeRequestCard.findFirst({
      where: { groupChatId, number },
      orderBy: { createdAt: 'desc' },
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

  setPendingRate(requestId: string, pendingRate: string | null): Promise<FinanceRequestCard> {
    return this.prisma.financeRequestCard.update({ where: { requestId }, data: { pendingRate } });
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
}
