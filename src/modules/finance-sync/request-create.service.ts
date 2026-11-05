import { Injectable, Logger } from '@nestjs/common';
import type { Manager } from '../../generated/prisma/client';
import { button } from '../telegram/core/bot-reply';
import { escapeHtml } from '../telegram/core/format';
import { TelegramSender } from '../telegram/core/telegram-sender';
import { FinanceClient } from './finance.client';
import {
  type CreateRequestBody,
  type FinanceFops,
  FinanceApiError,
  type RequestKind,
} from './finance.types';
import { groupCard, managerCard } from './request-card.messages';
import { RequestCardsRepository } from './request-cards.repository';

/** Already validated: money and rates are normalised decimal strings. */
export interface CreateRequestInput {
  kind: RequestKind;
  /** our_fop, foreign_fop, card */
  orders?: { orderNumber: string; amount: string; exchangeRate: string | null }[];
  /** minus */
  sum?: string;
  clientLabel?: string;
  sheetUrl?: string | null;
  withPercent?: boolean | null;
  exchangeRate: string | null;
  comment: string | null;
  officialDocs: boolean;
}

/** `created` with a `note` means the request exists but something after it did not go through. */
export type CreateResult =
  | { ok: true; requestId: string; number: string; note: string | null }
  | {
      ok: false;
      outcome: 'not-created' | 'unknown' | 'disabled';
      code: string;
      message: string;
    };

// finance create is idempotent per group message, so after the client's retry these may still have committed
const isAmbiguous = (error: unknown): boolean =>
  error instanceof FinanceApiError &&
  (error.code === 'network' || error.code === 'timeout' || error.status >= 500);

const minimalCard = (number: string, managerName: string): string =>
  `Запит #${escapeHtml(number)} · ${escapeHtml(managerName)}`;

function failureReason(error: unknown): string {
  if (error instanceof FinanceApiError) {
    if (error.code === 'order-taken') {
      const number = error.details?.orderNumber;
      return `${typeof number === 'string' ? `номер ${number}` : 'один з номерів'} уже має відкритий запит`;
    }
    if (error.code === 'duplicate-order') return 'номер повторюється в запиті';
    return `фінанси не прийняли запит (${error.code})`;
  }
  return 'внутрішня помилка';
}

@Injectable()
export class RequestCreateService {
  private readonly logger = new Logger(RequestCreateService.name);

  constructor(
    private readonly sender: TelegramSender,
    private readonly finance: FinanceClient,
    private readonly cards: RequestCardsRepository,
  ) {}

  /** Posts both cards itself; the result only tells the caller what to say to the manager. */
  async create(manager: Manager, input: CreateRequestInput): Promise<CreateResult> {
    if (!this.sender.financeEnabled) {
      return refused('disabled', 'finance-disabled', 'Ця функція ще не ввімкнена.');
    }
    const groupChatId = this.sender.adminChatId;
    const groupMessageId = await this.sender.sendToTopic('requests', '⏳ Створюю запит…');
    if (groupMessageId === null) {
      return notCreated('group-unavailable', 'не вдалося написати в групу');
    }

    let created: { id: string; number: string };
    try {
      created = await this.finance.create(financeBody(manager, input, groupChatId, groupMessageId));
    } catch (error) {
      if (isAmbiguous(error)) {
        await this.sender.editMessage(
          groupChatId,
          groupMessageId,
          `⚠️ Фінанси не відповіли — запит від ${escapeHtml(manager.name)} міг створитися, перевірте в кабінеті`,
        );
        return refused(
          'unknown',
          'finance-no-answer',
          input.orders
            ? 'Фінанси не відповіли, тож невідомо, чи створено запит. Спробуйте пізніше: якщо він уже є, бот скаже, що номер має відкритий запит.'
            : 'Фінанси не відповіли, тож невідомо, чи створено запит. Перш ніж повторювати, перевірте групу «Запити» або кабінет — повтор може створити дубль.',
        );
      }
      await this.sender.deleteMessage(groupChatId, groupMessageId);
      return notCreated(
        error instanceof FinanceApiError ? error.code : 'internal',
        failureReason(error),
      );
    }

    try {
      await this.cards.create({
        requestId: created.id,
        number: created.number,
        managerId: manager.id,
        managerChatId: manager.telegramId,
        groupChatId: BigInt(groupChatId),
        groupMessageId,
      });
    } catch (error) {
      this.logger.error(`Request ${created.id} was created but its card was not stored`, error);
      await this.sender.editMessage(
        groupChatId,
        groupMessageId,
        minimalCard(created.number, manager.name),
      );
      return made(
        created,
        `Запит #${created.number} створено, але бот не зможе показувати його статус. Перевіряйте в кабінеті.`,
      );
    }

    const [view, fops] = await Promise.all([
      this.finance.get(created.id).then(
        (r) => r.request,
        () => null,
      ),
      this.finance.fops(Number(manager.telegramId)).then(
        (f): FinanceFops | null => f,
        () => null,
      ),
    ]);
    if (!view) {
      await this.sender.editMessage(
        groupChatId,
        groupMessageId,
        minimalCard(created.number, manager.name),
        [[button('🔄 Оновити', `fu:${created.id}`)]],
      );
      return made(created, `Запит #${created.number} створено, картка з'явиться згодом.`);
    }

    const group = groupCard(view, fops, manager.name);
    await this.sender.editMessage(groupChatId, groupMessageId, group.html, group.buttons);

    const card = managerCard(view, { miniAppUrl: this.sender.miniAppUrl });
    const managerMessageId = await this.sender.send(manager.telegramId, card.html, card.buttons);
    if (managerMessageId === null) {
      return made(created, `Запит #${created.number} створено, картку не вдалося показати.`);
    }
    await this.cards.setManagerMessage(created.id, managerMessageId);
    return made(created, null);
  }
}

const refused = (
  outcome: 'not-created' | 'unknown' | 'disabled',
  code: string,
  message: string,
): CreateResult => ({ ok: false, outcome, code, message });

const notCreated = (code: string, reason: string): CreateResult =>
  refused('not-created', code, `Запит НЕ створено: ${reason}`);

const made = (created: { id: string; number: string }, note: string | null): CreateResult => ({
  ok: true,
  requestId: created.id,
  number: created.number,
  note,
});

const rateOf = (value: string | null): number | null => (value === null ? null : Number(value));

function financeBody(
  manager: Manager,
  input: CreateRequestInput,
  groupChatId: number,
  groupMessageId: number,
): CreateRequestBody {
  return {
    requesterTelegramId: Number(manager.telegramId),
    requesterName: manager.name,
    kind: input.kind,
    exchangeRate: rateOf(input.exchangeRate),
    comment: input.comment,
    officialDocs: input.officialDocs,
    groupChatId,
    groupMessageId,
    ...(input.orders && {
      orders: input.orders.map((o) => ({
        orderNumber: o.orderNumber,
        amount: Number(o.amount),
        exchangeRate: rateOf(o.exchangeRate),
      })),
    }),
    ...(input.sum !== undefined && {
      sum: Number(input.sum),
      clientLabel: input.clientLabel,
      sheetUrl: input.sheetUrl,
      withPercent: input.withPercent,
    }),
  };
}
