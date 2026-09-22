import { Injectable, Logger, type OnApplicationShutdown } from '@nestjs/common';
import { OrderStatus, type Payment, Prisma } from '../../../generated/prisma/client';
import { calculateOrderStatus } from '../../orders/order-status';
import { OrderCancelledError, OrderNotFoundError } from '../../orders/orders.errors';
import {
  type OrderWithManager,
  type OrderWithPaid,
  OrdersService,
} from '../../orders/orders.service';
import { PaymentAlreadyAttachedError, PaymentNotFoundError } from '../../payments/payments.errors';
import { PaymentsService } from '../../payments/payments.service';
import type { Initiator } from '../../refunds/refund.events';
import {
  NothingToRefundError,
  OrderHasPaymentsError,
  RefundAmountError,
} from '../../refunds/refunds.errors';
import { RefundsService } from '../../refunds/refunds.service';
import { BOT_RESTART_NOTICE, type BotReply, button, mention } from '../core/bot-reply';
import { escapeHtml, formatMoney } from '../core/format';
import { TelegramSender } from '../core/telegram-sender';
import { parseMoney } from '../order-draft/order-draft.parsers';
import { statusLabel } from '../orders-list/status-labels';

export const AdminAction = {
  AttachStart: /^attach:(\d+)$/,
  AttachConfirm: /^attach:ok:(\d+):(.+)$/,
  RefundAsk: /^refund:ask:(\d+):(\d+(?:\.\d{1,2})?)$/,
  RefundPartial: /^refund:part:(\d+)$/,
  RefundConfirm: /^refund:ok:(\d+):(\d+(?:\.\d{1,2})?)$/,
  CancelAsk: /^refund:void:(\d+)$/,
  CancelConfirm: /^refund:voidok:(\d+)$/,
  Dismiss: 'admin:dismiss',
} as const;

export interface Admin extends Initiator {
  userId: number;
}

const money = (value: Prisma.Decimal) => `${formatMoney(value)} грн`;
const dismissButton = button('Скасувати', AdminAction.Dismiss);
const warn = (text: string): BotReply => ({ html: `⚠️ ${text}` });

// How long a "reply to this message" prompt (attach a payment, enter a partial refund amount)
// waits for the admin's answer.
const ADMIN_PROMPT_TTL_MS = 10 * 60_000;

interface AttachPrompt {
  paymentId: number;
  expiresAt: number;
}

interface RefundPrompt {
  orderId: number;
  expiresAt: number;
}

function paymentSummary(payment: Payment): string {
  return `#${payment.id} · ${money(payment.amount)} · ${escapeHtml(payment.payerName ?? '—')}`;
}

@Injectable()
export class AdminFlowService implements OnApplicationShutdown {
  private readonly logger = new Logger(AdminFlowService.name);
  private readonly attachPrompts = new Map<bigint, AttachPrompt>();
  private readonly refundPrompts = new Map<bigint, RefundPrompt>();

  constructor(
    private readonly orders: OrdersService,
    private readonly payments: PaymentsService,
    private readonly refunds: RefundsService,
    private readonly sender: TelegramSender,
  ) {}

  // The bot is restarting: an admin mid-way through attaching a payment or entering a refund
  // amount would otherwise get no reply at all when they answer. A short warning makes that visible.
  async onApplicationShutdown(): Promise<void> {
    const now = Date.now();
    const ids = new Set<bigint>();
    for (const [id, prompt] of this.attachPrompts) {
      if (prompt.expiresAt > now) ids.add(id);
    }
    for (const [id, prompt] of this.refundPrompts) {
      if (prompt.expiresAt > now) ids.add(id);
    }
    await Promise.all([...ids].map((id) => this.sender.send(id, BOT_RESTART_NOTICE)));
  }

  async attachPrompt(paymentId: number, admin: Admin): Promise<BotReply> {
    const payment = await this.payments.findById(paymentId);
    if (!payment) {
      return warn(`Платіж #${paymentId} не знайдено.`);
    }
    if (payment.orderId !== null) {
      return warn(`Платіж #${paymentId} уже прив'язано до замовлення.`);
    }
    this.attachPrompts.set(admin.telegramId, {
      paymentId,
      expiresAt: Date.now() + ADMIN_PROMPT_TTL_MS,
    });
    return {
      html:
        `${mention(admin.userId, escapeHtml(admin.name))}, 🔗 Прив'язка платежу ${paymentSummary(payment)}\n` +
        'Надішліть номер замовлення у відповідь на це повідомлення.',
      forceReply: { placeholder: '0000-066717' },
    };
  }

  async attachPreview(paymentId: number, orderNumber: string): Promise<BotReply> {
    const [payment, found] = await Promise.all([
      this.payments.findById(paymentId),
      this.orders.findWithBalance(orderNumber),
    ]);
    if (!payment) {
      return warn(`Платіж #${paymentId} не знайдено.`);
    }
    if (payment.orderId !== null) {
      return warn(`Платіж #${paymentId} уже прив'язано до замовлення.`);
    }
    if (!found) {
      return warn(
        `Замовлення № ${escapeHtml(orderNumber.trim())} не знайдено. Надішліть номер ще раз у відповідь на запит.`,
      );
    }
    const { order, amountPaid } = found;
    if (order.status === OrderStatus.CANCELLED) {
      return warn(
        `Замовлення № ${escapeHtml(order.orderNumber)} скасоване — прив'язати до нього не можна.`,
      );
    }

    const after = amountPaid.plus(payment.amount);
    return {
      html: [
        `🔗 Прив'язати платіж ${paymentSummary(payment)} до замовлення № <b>${escapeHtml(order.orderNumber)}</b>?`,
        `ФОП: ${escapeHtml(order.clientName)} · менеджер ${escapeHtml(order.manager.name)}`,
        `Сума замовлення: ${money(order.amountDue)} · сплачено ${money(amountPaid)}`,
        `Після прив'язки: сплачено ${money(after)} → ${statusLabel(calculateOrderStatus(order.amountDue, after, order.status))}`,
      ].join('\n'),
      buttons: [
        [button("✅ Прив'язати", `attach:ok:${payment.id}:${order.orderNumber}`), dismissButton],
      ],
    };
  }

  async attach(paymentId: number, orderNumber: string, admin: Admin): Promise<BotReply> {
    try {
      const { order, amountPaid } = await this.payments.attach(paymentId, orderNumber);
      return {
        html:
          `✅ Платіж #${paymentId} прив'язано до № <b>${escapeHtml(order.orderNumber)}</b> · ${escapeHtml(admin.name)}\n` +
          `Сплачено ${money(amountPaid)} з ${money(order.amountDue)} → ${statusLabel(order.status)}`,
      };
    } catch (error) {
      return this.explain(error);
    }
  }

  async answerAttachPrompt(telegramId: bigint, answer: string): Promise<BotReply | null> {
    const prompt = this.attachPrompts.get(telegramId);
    if (!prompt) {
      return null;
    }
    this.attachPrompts.delete(telegramId);
    if (prompt.expiresAt < Date.now()) {
      return warn('Запит застарів. Натисніть кнопку ще раз.');
    }
    return this.attachPreview(prompt.paymentId, answer);
  }

  async refundMenu(orderNumber: string): Promise<BotReply> {
    if (!orderNumber.trim()) {
      return { html: 'Вкажіть номер замовлення: <code>/refund 0000-066717</code>' };
    }
    const found = await this.orders.findWithBalance(orderNumber);
    if (!found) {
      return warn(`Замовлення № ${escapeHtml(orderNumber.trim())} не знайдено.`);
    }
    const { order, amountPaid } = found;
    const lines = [
      `↩️ <b>Повернення · № ${escapeHtml(order.orderNumber)}</b>`,
      `ФОП: ${escapeHtml(order.clientName)} · менеджер ${escapeHtml(order.manager.name)}`,
      `Сума замовлення: ${money(order.amountDue)}`,
      `Сплачено: ${money(amountPaid)}`,
      `Статус: ${statusLabel(order.status)}`,
    ];

    if (!amountPaid.greaterThan(0)) {
      if (order.status === OrderStatus.CANCELLED) {
        return { html: [...lines, '', 'Замовлення вже скасоване, повертати нічого.'].join('\n') };
      }
      return {
        html: [
          ...lines,
          '',
          'Грошей за замовленням не надходило — його можна лише скасувати.',
        ].join('\n'),
        buttons: [[button('❌ Скасувати замовлення', `refund:void:${order.id}`), dismissButton]],
      };
    }

    const overpaid = amountPaid.minus(order.amountDue);
    const buttons = [
      ...(overpaid.greaterThan(0)
        ? [
            [
              button(
                `Повернути переплату ${formatMoney(overpaid)}`,
                `refund:ask:${order.id}:${overpaid.toFixed(2)}`,
              ),
            ],
          ]
        : []),
      [
        button(
          `Повернути все: ${formatMoney(amountPaid)}`,
          `refund:ask:${order.id}:${amountPaid.toFixed(2)}`,
        ),
      ],
      [button('Інша сума…', `refund:part:${order.id}`), dismissButton],
    ];
    return { html: lines.join('\n'), buttons };
  }

  async refundPrompt(orderId: number, admin: Admin): Promise<BotReply> {
    const found = await this.findOrderById(orderId);
    if (!found) {
      return warn('Замовлення не знайдено.');
    }
    this.refundPrompts.set(admin.telegramId, {
      orderId,
      expiresAt: Date.now() + ADMIN_PROMPT_TTL_MS,
    });
    return {
      html:
        `${mention(admin.userId, escapeHtml(admin.name))}, ↩️ Часткове повернення · № ${escapeHtml(found.order.orderNumber)} · сплачено ${money(found.amountPaid)}\n` +
        'Надішліть суму повернення у відповідь на це повідомлення.',
      forceReply: { placeholder: '1 250,50' },
    };
  }

  async answerRefundPrompt(telegramId: bigint, answer: string): Promise<BotReply | null> {
    const prompt = this.refundPrompts.get(telegramId);
    if (!prompt) {
      return null;
    }
    this.refundPrompts.delete(telegramId);
    if (prompt.expiresAt < Date.now()) {
      return warn('Запит застарів. Натисніть кнопку ще раз.');
    }
    const amount = parseMoney(answer);
    if (!amount.ok) {
      return warn(`${escapeHtml(amount.error)} Надішліть суму ще раз у відповідь на запит.`);
    }
    const found = await this.findOrderById(prompt.orderId);
    return found ? this.refundConfirmFor(found, amount.value) : warn('Замовлення не знайдено.');
  }

  async refundConfirm(orderId: number, amount: string): Promise<BotReply> {
    const found = await this.findOrderById(orderId);
    return found ? this.refundConfirmFor(found, amount) : warn('Замовлення не знайдено.');
  }

  async refund(orderId: number, amount: string, admin: Admin): Promise<BotReply> {
    try {
      const { order, refund, amountPaid } = await this.refunds.refund(orderId, amount, admin);
      return {
        html:
          `✅ Повернення ${money(refund.amount)} за № <b>${escapeHtml(order.orderNumber)}</b> оформлено · ${escapeHtml(admin.name)}\n` +
          `Сплачено чистими: ${money(amountPaid)} → ${statusLabel(order.status)}`,
      };
    } catch (error) {
      return this.explain(error);
    }
  }

  async cancelConfirm(orderId: number): Promise<BotReply> {
    const found = await this.findOrderById(orderId);
    if (!found) {
      return warn('Замовлення не знайдено.');
    }
    return {
      html: `Скасувати замовлення № <b>${escapeHtml(found.order.orderNumber)}</b>? Воно зникне зі списку неоплачених, менеджер отримає сповіщення.`,
      buttons: [
        [
          button('❌ Так, скасувати', `refund:voidok:${orderId}`),
          button('Ні', AdminAction.Dismiss),
        ],
      ],
    };
  }

  async cancel(orderId: number, admin: Admin): Promise<BotReply> {
    try {
      const { order } = await this.refunds.cancelUnpaid(orderId, admin, {
        wholeNumber: true,
      });
      return {
        html: `❌ Замовлення № <b>${escapeHtml(order.orderNumber)}</b> скасовано · ${escapeHtml(admin.name)}`,
      };
    } catch (error) {
      return this.explain(error);
    }
  }

  private refundConfirmFor(
    { order, amountPaid }: OrderWithPaid<OrderWithManager>,
    amount: string,
  ): BotReply {
    const value = new Prisma.Decimal(amount);
    if (!value.greaterThan(0) || value.greaterThan(amountPaid)) {
      return warn(`Повернути можна від 0,01 до ${money(amountPaid)}.`);
    }
    const after = amountPaid.minus(value);
    const status = after.isZero()
      ? OrderStatus.CANCELLED
      : calculateOrderStatus(order.amountDue, after, order.status);
    return {
      html: [
        `Підтвердіть повернення <b>${money(value)}</b> за № <b>${escapeHtml(order.orderNumber)}</b>.`,
        `Після повернення: сплачено ${money(after)} з ${money(order.amountDue)} → ${statusLabel(status)}`,
      ].join('\n'),
      buttons: [
        [
          button(`✅ Повернути ${formatMoney(value)}`, `refund:ok:${order.id}:${value.toFixed(2)}`),
          dismissButton,
        ],
      ],
    };
  }

  private findOrderById(orderId: number): Promise<OrderWithPaid<OrderWithManager> | null> {
    return this.orders.findWithBalanceById(orderId);
  }

  private explain(error: unknown): BotReply {
    if (error instanceof PaymentNotFoundError)
      return warn(`Платіж #${error.paymentId} не знайдено.`);
    if (error instanceof PaymentAlreadyAttachedError)
      return warn(`Платіж #${error.paymentId} уже прив'язано.`);
    if (error instanceof OrderNotFoundError)
      return warn(`Замовлення № ${escapeHtml(error.orderNumber)} не знайдено.`);
    if (error instanceof OrderCancelledError)
      return warn(`Замовлення № ${escapeHtml(error.orderNumber)} уже скасоване.`);
    if (error instanceof RefundAmountError)
      return warn(
        `Повернути можна від 0,01 до ${money(error.available)}. Баланс змінився — відкрийте /refund ${escapeHtml(error.orderNumber)} ще раз.`,
      );
    if (error instanceof NothingToRefundError)
      return warn(`За замовленням № ${escapeHtml(error.orderNumber)} повертати нічого.`);
    if (error instanceof OrderHasPaymentsError)
      return warn(
        `За замовленням № ${escapeHtml(error.orderNumber)} сплачено ${money(error.paid)} — спершу оформіть повернення: /refund ${escapeHtml(error.orderNumber)}`,
      );
    this.logger.error('Unexpected error in an admin action', error);
    return warn('Щось пішло не так. Спробуйте ще раз.');
  }
}
