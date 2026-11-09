import { Injectable } from '@nestjs/common';
import type { FinanceRequestCard } from '../../generated/prisma/client';
import { ManagersService } from '../managers/managers.service';
import { OrdersService } from '../orders/orders.service';
import { escapeHtml } from '../telegram/core/format';
import { TelegramSender } from '../telegram/core/telegram-sender';
import { FinanceClient } from './finance.client';
import {
  type FinanceEvent,
  type FinanceFops,
  type FinanceRequestView,
  paysAfterConfirm,
} from './finance.types';
import { groupCard, managerCard } from './request-card.messages';
import { RequestCardsRepository } from './request-cards.repository';
import { storedPayments } from './stored-payments';

// left in place of a card that moved down, in case Telegram refuses to delete it
const movedStub = (view: FinanceRequestView): string =>
  `⬇️ Запит #${escapeHtml(view.number)}: актуальна картка нижче`;

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
    const { html, buttons } = await this.managerReply(card, view);
    await this.sender.editMessage(card.managerChatId, card.managerMessageId, html, buttons);
  }

  private async managerReply(card: FinanceRequestCard, view: FinanceRequestView) {
    return managerCard(view, {
      miniAppUrl: this.sender.miniAppUrl,
      payments: storedPayments(card.payments),
      completed: card.completedAt
        ? {
            orderNumbers: await this.orders.numbersByIds(card.orderIds),
            closed: card.closedAt != null,
            // shows when the client paid: a closed our_fop or foreign_fop card, or any other kind once dated
            paidAt:
              card.closedAt || !paysAfterConfirm(view.kind)
                ? await this.orders.latestPaidAt(card.orderIds)
                : null,
          }
        : false,
    });
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

  /**
   * No separate notices: a financier's answer (accepted, cancelled) moves the one card to the bottom of
   * the chat, so the manager gets a single message with a ping; a payment only redraws the card in place.
   * `markNotified` makes concurrent duplicates and webhook echoes silent.
   */
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
    if (status === 'paid') return;
    const { html, buttons } = await this.managerReply(card, view);
    const sent = await this.sender.send(card.managerChatId, html, buttons);
    // not delivered: let the next event try again; the old card is still there and up to date
    if (sent === null) {
      await this.cards.resetNotified(view.id, status);
      return;
    }
    await this.cards.setManagerMessage(view.id, sent);
    const old = card.managerMessageId;
    if (old === null) return;
    // a reply to the old message still reaches the request, should Telegram keep it
    await this.cards.rememberChatMessage(card.managerChatId, old, view.id);
    await this.sender.editMessage(card.managerChatId, old, movedStub(view), []);
    await this.sender.deleteMessage(card.managerChatId, old);
  }

  /** Finance marks the message `sent` once we answer, so a failed delivery must fail the webhook. */
  private async relayMessage(
    card: FinanceRequestCard,
    message: NonNullable<FinanceEvent['message']>,
  ): Promise<void> {
    // shortcut: a parallel duplicate within finance's 10 s timeout can be acked while the first attempt later fails, losing the message; upgrade to a delivery status per messageId if it shows up
    if (!(await this.cards.markSeen(message.messageId))) return;
    let textSent = false;
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
        textSent = true;
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
      // a retry would send the text again, so the manager is told about the lost file instead
      if (textSent) {
        await this.sender.send(
          card.managerChatId,
          `⚠️ Файл «${escapeHtml(message.fileName ?? '')}» не доставлено, він є в чаті запиту в кабінеті`,
          undefined,
          false,
          { replyTo: card.managerMessageId ?? undefined },
        );
        return;
      }
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
