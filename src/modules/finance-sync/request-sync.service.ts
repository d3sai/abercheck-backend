import { Injectable } from '@nestjs/common';
import type { FinanceRequestCard } from '../../generated/prisma/client';
import { ManagersService } from '../managers/managers.service';
import { OrdersService } from '../orders/orders.service';
import { escapeHtml } from '../telegram/core/format';
import { TelegramSender } from '../telegram/core/telegram-sender';
import { FinanceClient } from './finance.client';
import type { FinanceEvent, FinanceFops, FinanceRequestView } from './finance.types';
import { groupCard, managerCard } from './request-card.messages';
import { RequestCardsRepository } from './request-cards.repository';
import { storedPayments } from './stored-payments';

const NOTICE = {
  accepted: (view: FinanceRequestView) =>
    `✅ Запит #${escapeHtml(view.number)} прийнято${view.fopLabel ? ` · ФОП: ${escapeHtml(view.fopLabel)}` : ''}`,
  cancelled: (view: FinanceRequestView) => `❌ Запит #${escapeHtml(view.number)} скасовано`,
  paid: (view: FinanceRequestView) => `💰 Запит #${escapeHtml(view.number)} оплачено`,
};

@Injectable()
export class RequestSyncService {
  constructor(
    private readonly sender: TelegramSender,
    private readonly finance: FinanceClient,
    private readonly cards: RequestCardsRepository,
    private readonly managers: ManagersService,
    private readonly orders: OrdersService,
  ) {}

  /** The webhook is only a hint: redraw both cards from the re-read view, then relay what is new. */
  async handle(event: FinanceEvent): Promise<void> {
    const card = await this.cards.byRequestId(event.requestId);
    if (!card) return;
    const { request: view } = await this.finance.get(card.requestId);
    await this.renderGroup(card, view);
    await this.renderManager(card, view);
    await this.notifyManager(view);
    if (event.type === 'message' && event.message) await this.relayMessage(card, event.message);
  }

  async renderManager(card: FinanceRequestCard, view: FinanceRequestView): Promise<void> {
    if (card.managerMessageId === null) return;
    const { html, buttons } = managerCard(view, {
      miniAppUrl: this.sender.miniAppUrl,
      payments: storedPayments(card.payments),
      completed: card.completedAt
        ? {
            orderNumbers: await this.orders.numbersByIds(card.orderIds),
            closed: card.closedAt != null,
            // a closed our_fop card shows when the client paid
            paidAt:
              card.closedAt && view.kind === 'our_fop'
                ? await this.orders.latestPaidAt(card.orderIds)
                : null,
          }
        : false,
    });
    await this.sender.editMessage(card.managerChatId, card.managerMessageId, html, buttons);
  }

  /** Redraws the group card; a pending one also needs the FOP list for its buttons. */
  async renderGroup(card: FinanceRequestCard, view: FinanceRequestView): Promise<void> {
    const [fops, manager] = await Promise.all([
      view.status === 'pending'
        ? this.finance.fops(Number(card.managerChatId)).catch((): FinanceFops | null => null)
        : null,
      this.managers.findById(card.managerId),
    ]);
    const { html, buttons } = groupCard(view, fops, manager?.name);
    await this.sender.editMessage(card.groupChatId, card.groupMessageId, html, buttons);
  }

  /** One short line per status change; `markNotified` makes concurrent duplicates and webhook echoes silent. */
  async notifyManager(view: FinanceRequestView): Promise<void> {
    const status =
      view.status === 'cancelled'
        ? 'cancelled'
        : view.isPaid
          ? 'paid'
          : view.status === 'accepted'
            ? 'accepted'
            : null;
    if (!status) return;
    const card = await this.cards.byRequestId(view.id);
    if (!card || !(await this.cards.markNotified(view.id, status))) return;
    const sent = await this.sender.send(
      card.managerChatId,
      NOTICE[status](view),
      undefined,
      false,
      { replyTo: card.managerMessageId ?? undefined },
    );
    // not delivered: let the next event notify again instead of losing the notice
    if (sent === null) await this.cards.resetNotified(view.id, status);
    // a manager reply to the notice then goes to the request chat, not to order parsing
    else await this.cards.rememberChatMessage(card.managerChatId, sent, view.id);
  }

  /** Finance marks the message `sent` once we answer, so a failed delivery must fail the webhook. */
  private async relayMessage(
    card: FinanceRequestCard,
    message: NonNullable<FinanceEvent['message']>,
  ): Promise<void> {
    // shortcut: a parallel duplicate within finance's 10 s timeout can be acked while the first attempt later fails, losing the message; upgrade to a delivery status per messageId if it shows up
    if (!(await this.cards.markSeen(message.messageId))) return;
    try {
      const line = `💬 ${escapeHtml(message.author)}`;
      const replyTo = card.managerMessageId ?? undefined;
      // fetched first: a failure then throws before anything is sent, so the retry cannot duplicate the text
      const file = message.fileName
        ? await this.finance.file(card.requestId, message.messageId)
        : null;
      if (message.body) {
        await this.deliver(card, () =>
          this.sender.send(
            card.managerChatId,
            `${line}: ${escapeHtml(message.body!)}`,
            undefined,
            false,
            { replyTo },
          ),
        );
      }
      if (file) {
        await this.deliver(card, () =>
          this.sender.sendDocument(
            card.managerChatId,
            { source: file.data, filename: file.filename },
            line,
            replyTo,
          ),
        );
      }
    } catch (error) {
      await this.cards.unmarkSeen(message.messageId);
      throw error;
    }
  }

  private async deliver(
    card: FinanceRequestCard,
    send: () => Promise<number | null>,
  ): Promise<void> {
    const id = await send();
    if (id === null)
      throw new Error(`Could not deliver a finance message to chat ${card.managerChatId}`);
    await this.cards.rememberChatMessage(card.managerChatId, id, card.requestId);
  }
}
