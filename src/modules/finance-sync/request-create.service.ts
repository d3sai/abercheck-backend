import { Injectable, Logger } from '@nestjs/common';
import type { Manager } from '../../generated/prisma/client';
import { type BotReply, button } from '../telegram/core/bot-reply';
import { escapeHtml } from '../telegram/core/format';
import { TelegramSender } from '../telegram/core/telegram-sender';
import {
  type ParseResult,
  parseExchangeRate,
  parseMoney,
  parseOrderNumber,
} from '../telegram/order-draft/order-draft.parsers';
import { FinanceClient } from './finance.client';
import { type FinanceFops, FinanceApiError } from './finance.types';
import { groupCard, managerCard } from './request-card.messages';
import { RequestCardsRepository } from './request-cards.repository';

export interface ParsedTestRequest {
  orders: { orderNumber: string; amount: string }[];
  exchangeRate: string | null;
  comment: string | null;
  officialDocs: boolean;
}

const USAGE = [
  '/testrequest',
  '0000-070217 4972',
  '0000-072611 11124,50',
  'курс 45,7',
  'документи так',
  'коментар Терміново',
].join('\n');

const parseError = (error: string): BotReply => ({
  html: `⚠️ ${escapeHtml(error)}\n\nФормат:\n<pre>${USAGE}</pre>\nКурс і коментар — за потреби.`,
});

/** Body of /testrequest: one `<number> <sum>` per line plus `курс`, `документи так|ні`, `коментар`. */
export function parseTestRequest(
  text: string,
): { ok: true; value: ParsedTestRequest } | { ok: false; error: string } {
  const orders: ParsedTestRequest['orders'] = [];
  let exchangeRate: string | null = null;
  let comment: string | null = null;
  let officialDocs: boolean | null = null;

  for (const line of text.split('\n').map((l) => l.trim())) {
    if (line === '') continue;
    const keyword = /^(курс|документи|коментар)(?:\s+(.*))?$/iu.exec(line);
    if (keyword) {
      const value = (keyword[2] ?? '').trim();
      switch (keyword[1]!.toLowerCase()) {
        case 'курс': {
          const rate = parseExchangeRate(value);
          if (!rate.ok) return rate;
          exchangeRate = rate.value;
          break;
        }
        case 'документи': {
          const answer = value.toLowerCase();
          if (answer !== 'так' && answer !== 'ні') {
            return { ok: false, error: 'Документи: так або ні.' };
          }
          officialDocs = answer === 'так';
          break;
        }
        default:
          comment = value || null;
      }
      continue;
    }
    const order = /^(\S+)\s+(.+)$/u.exec(line);
    if (!order) return { ok: false, error: `Не розумію рядок: ${line}` };
    const number: ParseResult = parseOrderNumber(order[1]!);
    if (!number.ok) return number;
    const amount = parseMoney(order[2]!);
    if (!amount.ok) return amount;
    orders.push({ orderNumber: number.value, amount: amount.value });
  }

  if (orders.length === 0) return { ok: false, error: 'Додайте хоча б одне замовлення.' };
  if (officialDocs === null) return { ok: false, error: 'Вкажіть документи: так або ні.' };
  return { ok: true, value: { orders, exchangeRate, comment, officialDocs } };
}

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
      return `${typeof number === 'string' ? `номер ${escapeHtml(number)}` : 'один з номерів'} уже має відкритий запит`;
    }
    if (error.code === 'duplicate-order') return 'номер повторюється в запиті';
    return `фінанси не прийняли запит (${escapeHtml(error.code)})`;
  }
  return 'внутрішня помилка';
}

// shortcut: temporary /testrequest flow, delete it when the Part 3 Mini App replaces it.
@Injectable()
export class RequestCreateService {
  private readonly logger = new Logger(RequestCreateService.name);

  constructor(
    private readonly sender: TelegramSender,
    private readonly finance: FinanceClient,
    private readonly cards: RequestCardsRepository,
  ) {}

  async handle(manager: Manager, payload: string): Promise<BotReply | null> {
    if (!this.sender.financeEnabled) return { html: 'Ця функція ще не ввімкнена.' };
    const parsed = parseTestRequest(payload);
    return parsed.ok ? this.create(manager, parsed.value) : parseError(parsed.error);
  }

  /** Null means the manager card itself was already sent, so there is nothing to reply. */
  async create(manager: Manager, input: ParsedTestRequest): Promise<BotReply | null> {
    const groupChatId = this.sender.adminChatId;
    const groupMessageId = await this.sender.sendToTopic('requests', '⏳ Створюю запит…');
    if (groupMessageId === null) {
      return notCreated('не вдалося написати в групу');
    }

    let created: { id: string; number: string };
    try {
      created = await this.finance.create({
        requesterTelegramId: Number(manager.telegramId),
        requesterName: manager.name,
        kind: 'our_fop',
        orders: input.orders.map((o) => ({ orderNumber: o.orderNumber, amount: Number(o.amount) })),
        exchangeRate: input.exchangeRate === null ? null : Number(input.exchangeRate),
        comment: input.comment,
        officialDocs: input.officialDocs,
        groupChatId,
        groupMessageId,
      });
    } catch (error) {
      if (isAmbiguous(error)) {
        await this.sender.editMessage(
          groupChatId,
          groupMessageId,
          `⚠️ Фінанси не відповіли — запит від ${escapeHtml(manager.name)} міг створитися, перевірте в кабінеті`,
        );
        return {
          html: '⚠️ Фінанси не відповіли, тож невідомо, чи створено запит. Спробуйте пізніше: якщо він уже є, бот скаже, що номер має відкритий запит.',
        };
      }
      await this.sender.deleteMessage(groupChatId, groupMessageId);
      return notCreated(failureReason(error));
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
      return {
        html: `✅ Запит #${escapeHtml(created.number)} створено, але бот не зможе показувати його статус. Перевіряйте в кабінеті.`,
      };
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
      return { html: `✅ Запит #${escapeHtml(created.number)} створено, картка з'явиться згодом.` };
    }

    const group = groupCard(view, fops, null, manager.name);
    await this.sender.editMessage(groupChatId, groupMessageId, group.html, group.buttons);

    const card = managerCard(view);
    const managerMessageId = await this.sender.send(manager.telegramId, card.html, card.buttons);
    if (managerMessageId === null) {
      return {
        html: `✅ Запит #${escapeHtml(created.number)} створено, картку не вдалося показати.`,
      };
    }
    await this.cards.setManagerMessage(created.id, managerMessageId);
    return null;
  }
}

const notCreated = (reason: string): BotReply => ({ html: `⚠️ Запит НЕ створено: ${reason}` });
