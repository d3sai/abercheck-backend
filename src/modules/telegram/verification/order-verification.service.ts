import { Injectable, Logger } from '@nestjs/common';
import type { InlineKeyboardButton } from 'telegraf/types';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { type Order, OrderStatus, type Prisma } from '../../../generated/prisma/client';
import type { Initiator } from '../../refunds/refund.events';
import { escapeHtml } from '../core/format';
import { TelegramSender } from '../core/telegram-sender';
import {
  type DigestItem,
  type ProblemCode,
  type VerifyState,
  controlsMessage,
  maskOf,
  problemNotice,
  problemsOf,
  reasonButtons,
  verifyButtons,
} from './verification.messages';

export type VerifyResult = { buttons: InlineKeyboardButton[][] } | { error: string };

const NOT_FOUND = { error: '⚠️ Замовлення не знайдено' };
const DIGEST_DAYS = 14;
const DAY_MS = 24 * 60 * 60 * 1000;

const STATE_SELECT = {
  id: true,
  verifiedAt: true,
  verifiedByName: true,
  problem: true,
  problemAt: true,
  problemByName: true,
  verifyMessageId: true,
} as const;

type Stored = VerifyState & { verifyMessageId: number | null };

const groupOf = (order: Stored): Prisma.OrderWhereInput =>
  order.verifyMessageId === null ? { id: order.id } : { verifyMessageId: order.verifyMessageId };

@Injectable()
export class OrderVerificationService {
  private readonly logger = new Logger(OrderVerificationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly sender: TelegramSender,
  ) {}

  async attachControls(
    orders: Pick<Order, 'id' | 'orderNumber'>[],
    messageId: number | null,
  ): Promise<void> {
    const first = orders[0];
    if (!first) return;
    try {
      const buttons = verifyButtons({
        id: first.id,
        verifiedAt: null,
        verifiedByName: null,
        problem: null,
        problemAt: null,
        problemByName: null,
      });
      const onNotice =
        messageId !== null &&
        (await this.sender.editButtons(this.sender.adminChatId, messageId, buttons));
      const holder = onNotice
        ? messageId
        : await this.sender.sendToTopic(
            'payments',
            controlsMessage(orders.map((order) => order.orderNumber)),
            buttons,
            messageId === null ? {} : { replyTo: messageId },
          );
      if (holder === null) return await this.warnNoControls(orders);
      await this.prisma.order.updateMany({
        where: { id: { in: orders.map((order) => order.id) } },
        data: { verifyMessageId: holder },
      });
    } catch (error) {
      this.logger.error(`Failed to attach the verify buttons of order #${first.id}`, error);
      await this.warnNoControls(orders);
    }
  }

  /** Without a stored holder the order never reaches the digest: the admins must hear of it. */
  private async warnNoControls(orders: Pick<Order, 'orderNumber'>[]): Promise<void> {
    await this.sender.sendToTopic(
      'payments',
      `⚠️ Кнопки звірки не додано: № ${escapeHtml(orders.map((order) => order.orderNumber).join(', '))}`,
    );
  }

  async verify(orderId: number, admin: Initiator): Promise<VerifyResult> {
    const order = await this.stored(orderId);
    if (!order) return NOT_FOUND;
    const data = {
      verifiedAt: new Date(),
      verifiedByName: admin.name,
      problem: null,
      problemAt: null,
      problemByName: null,
    };
    await this.prisma.order.updateMany({ where: groupOf(order), data });
    return { buttons: verifyButtons({ ...order, ...data }) };
  }

  async undo(orderId: number): Promise<VerifyResult> {
    const order = await this.stored(orderId);
    if (!order) return NOT_FOUND;
    const data = { verifiedAt: null, verifiedByName: null };
    await this.prisma.order.updateMany({ where: groupOf(order), data });
    return { buttons: verifyButtons({ ...order, ...data }) };
  }

  async problem(
    orderId: number,
    codes: ProblemCode[],
    admin: Initiator,
  ): Promise<VerifyResult & { delivered?: boolean }> {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      select: {
        ...STATE_SELECT,
        orderNumber: true,
        clientName: true,
        amountDue: true,
        currency: true,
        manager: { select: { telegramId: true } },
      },
    });
    if (!order) return NOT_FOUND;
    const data = {
      problem: codes.join(','),
      problemAt: new Date(),
      problemByName: admin.name,
      verifiedAt: null,
      verifiedByName: null,
    };
    await this.prisma.order.updateMany({ where: groupOf(order), data });
    const card = await this.prisma.financeRequestCard.findFirst({
      where: { orderIds: { has: orderId }, managerChatId: order.manager.telegramId },
      select: { managerMessageId: true },
    });
    const sent = await this.sender.send(
      order.manager.telegramId,
      problemNotice(order, codes),
      undefined,
      false,
      card?.managerMessageId ? { replyTo: card.managerMessageId } : {},
    );
    return { buttons: verifyButtons({ ...order, ...data }), delivered: sent !== null };
  }

  async reasons(orderId: number, mask?: number): Promise<VerifyResult> {
    const order = await this.stored(orderId);
    return order
      ? { buttons: reasonButtons(order.id, mask ?? maskOf(problemsOf(order.problem))) }
      : NOT_FOUND;
  }

  async back(orderId: number): Promise<VerifyResult> {
    const order = await this.stored(orderId);
    return order ? { buttons: verifyButtons(order) } : NOT_FOUND;
  }

  async digestItems(now: Date): Promise<DigestItem[]> {
    const orders = await this.prisma.order.findMany({
      where: {
        verifiedAt: null,
        verifyMessageId: { not: null },
        status: { not: OrderStatus.CANCELLED },
        createdAt: { gte: new Date(now.getTime() - DIGEST_DAYS * DAY_MS) },
      },
      orderBy: { createdAt: 'asc' },
      select: {
        orderNumber: true,
        clientName: true,
        amountDue: true,
        currency: true,
        createdAt: true,
        problem: true,
        verifyMessageId: true,
        manager: { select: { name: true } },
      },
    });
    return orders.map((order) => ({
      orderNumber: order.orderNumber,
      clientName: order.clientName,
      amountDue: order.amountDue,
      currency: order.currency,
      managerName: order.manager.name,
      createdAt: order.createdAt,
      problems: problemsOf(order.problem),
      verifyMessageId: order.verifyMessageId!,
    }));
  }

  private stored(orderId: number): Promise<Stored | null> {
    return this.prisma.order.findUnique({ where: { id: orderId }, select: STATE_SELECT });
  }
}
