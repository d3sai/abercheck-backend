import { forwardRef, Inject, Injectable, Logger } from '@nestjs/common';
import type { Context } from 'telegraf';
import { PrismaService } from '../../common/prisma/prisma.service';
import type { Manager, Order, OrderRequisite } from '../../generated/prisma/client';
import { AttachmentStorageError } from '../attachments/attachments.errors';
import {
  ALLOWED_MIME_TYPES,
  MAX_FILE_SIZE_BYTES,
  MAX_FILES_PER_UPLOAD,
} from '../attachments/attachments.constants';
import { AttachmentsService, type TelegramFileRef } from '../attachments/attachments.service';
import { ManagersService } from '../managers/managers.service';
import { NOT_A_MANAGER } from '../telegram/access/access.messages';
import type { BotReply } from '../telegram/core/bot-reply';
import { button } from '../telegram/core/bot-reply';
import { type MatchContext, edit, isPrivate, reply } from '../telegram/core/telegram-context';
import { OrderDraftService } from '../telegram/order-draft/order-draft.service';
import { paymentButtonLabel, receiptCaption } from './request-card.messages';
import { PendingOrdersRepository } from './pending-orders.repository';
import { RequestCardsRepository } from './request-cards.repository';

type Next = () => Promise<void>;

const OPEN_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
const CHOICE_TTL_MS = 10 * 60 * 1000;

/** Files sent loose while the manager has several open requests, waiting for «До якого запиту?». */
interface Choice {
  files: TelegramFileRef[];
  expiresAt: number;
}

/** Files waiting for «До якого платежу?»: the request's order has several payments. */
interface PaymentChoice {
  requestId: string;
  files: TelegramFileRef[];
  expiresAt: number;
}

const fileRefusal = (file: TelegramFileRef): string | null => {
  if (!ALLOWED_MIME_TYPES.has(file.mimeType)) {
    return '⚠️ Такий тип файлу не підтримується. Додайте фото, PDF або зображення.';
  }
  return file.size > MAX_FILE_SIZE_BYTES ? '⚠️ Файл завеликий. Максимум 10 МБ.' : null;
};

const NO_ORDER = 'Запит оформлено, але бот не знайшов замовлення — додайте квитанцію в кабінеті';

/** Receipts a manager sends in the bot chat as a reply to their request. */
/** `stored`: the receipt was kept; the text then only serves if the 👍 reaction fails. */
type ReceiptAnswer = BotReply & { stored?: true; queued?: true };

@Injectable()
export class RequestReceiptsService {
  private readonly logger = new Logger(RequestReceiptsService.name);

  constructor(
    private readonly cards: RequestCardsRepository,
    private readonly prisma: PrismaService,
    private readonly attachments: AttachmentsService,
    private readonly managers: ManagersService,
    @Inject(forwardRef(() => OrderDraftService)) private readonly drafts: OrderDraftService,
    private readonly pending: PendingOrdersRepository,
  ) {}

  private readonly choices = new Map<bigint, Choice>();
  private readonly paymentChoices = new Map<bigint, PaymentChoice>();

  /** Handles only files replied to a card or a relayed message of the sender's own request. */
  async onFile(ctx: Context, file: TelegramFileRef, next: Next): Promise<void> {
    const message = ctx.message;
    const target = message && 'reply_to_message' in message ? message.reply_to_message : undefined;
    if (!ctx.from || !isPrivate(ctx)) return next();
    if (!target) {
      // a Kit, cash or foreign text mode takes its own files
      if (this.drafts.isArmed(BigInt(ctx.from.id))) return next();
      return this.onLooseFile(ctx, file);
    }

    const chatId = BigInt(ctx.chat!.id);
    const requestId =
      (await this.cards.byManagerMessage(chatId, target.message_id))?.requestId ??
      (await this.cards.requestOfChatMessage(chatId, target.message_id));
    if (!requestId) return this.onDraftFile(ctx, chatId, target.message_id, file, next);

    const manager = await this.managers.findActiveByTelegramId(BigInt(ctx.from.id));
    if (!manager) {
      await reply(ctx, { html: NOT_A_MANAGER }, message!.message_id);
      return;
    }
    if ((await this.cards.byRequestId(requestId))?.managerId !== manager.id) return next();
    await this.answer(ctx, await this.receive(manager, requestId, file));
  }

  /** A file replied to the card of a Kit, cash or foreign order that waits for «Прийняти»: it is held on the draft. */
  private async onDraftFile(
    ctx: Context,
    chatId: bigint,
    messageId: number,
    file: TelegramFileRef,
    next: Next,
  ): Promise<void> {
    const draftId = await this.pending.idOfMessage(chatId, messageId);
    if (!draftId) return next();
    const manager = await this.managers.findActiveByTelegramId(BigInt(ctx.from!.id));
    if (!manager) {
      await reply(ctx, { html: NOT_A_MANAGER }, ctx.message!.message_id);
      return;
    }
    if ((await this.pending.byId(draftId))?.managerId !== manager.id) return next();
    const refusal = fileRefusal(file);
    if (refusal) return this.answer(ctx, { html: refusal });
    const outcome = await this.pending.addFile(draftId, file, MAX_FILES_PER_UPLOAD);
    await this.answer(
      ctx,
      outcome === 'added'
        ? {
            html: '📎 Квитанцію збережено — вона піде з замовленням після «Прийняти»',
            stored: true,
          }
        : {
            html:
              outcome === 'full'
                ? `⚠️ Максимум ${MAX_FILES_PER_UPLOAD} файлів на замовлення.`
                : 'Запит не знайдено',
          },
    );
  }

  /** A stored receipt gets a 👍 on the file instead of one more message. */
  private async answer(ctx: Context, answer: ReceiptAnswer): Promise<void> {
    const messageId = ctx.message?.message_id;
    // joined the question already asked for the files before it
    if (answer.queued) return;
    if (answer.stored) {
      await ctx.react('👍').catch(() => reply(ctx, answer, messageId));
      return;
    }
    await reply(ctx, answer, messageId);
  }

  /**
   * A file sent straight into the chat: with one open request it goes there; with several the bot asks
   * once which one (files sent meanwhile, e.g. an album, join the same question).
   */
  private async onLooseFile(ctx: Context, file: TelegramFileRef): Promise<void> {
    const userId = BigInt(ctx.from!.id);
    const manager = await this.managers.findActiveByTelegramId(userId);
    if (!manager) {
      await reply(ctx, { html: NOT_A_MANAGER }, ctx.message?.message_id);
      return;
    }
    const pending = this.choices.get(userId);
    if (pending && pending.expiresAt > Date.now()) {
      pending.files.push(file);
      return;
    }
    const open = await this.cards.openOfManager(manager.id, new Date(Date.now() - OPEN_WINDOW_MS));
    if (open.length === 0) {
      await reply(
        ctx,
        { html: 'Немає відкритого запиту, до якого можна додати файл.' },
        ctx.message?.message_id,
      );
      return;
    }
    if (open.length === 1) {
      await this.answer(ctx, await this.receive(manager, open[0]!.requestId, file));
      return;
    }
    this.choices.set(userId, { files: [file], expiresAt: Date.now() + CHOICE_TTL_MS });
    await reply(
      ctx,
      {
        html: '📎 До якого запиту додати файл?',
        buttons: open.map((card) => [button(`Запит #${card.number}`, `mr:${card.requestId}`)]),
      },
      ctx.message?.message_id,
    );
  }

  /** «Запит #N» under the question: the waiting files go to that request. */
  async onChoice(ctx: MatchContext): Promise<void> {
    if (!ctx.from || !isPrivate(ctx)) return;
    const userId = BigInt(ctx.from.id);
    const pending = this.choices.get(userId);
    this.choices.delete(userId);
    const manager = await this.managers.findActiveByTelegramId(userId);
    const card = await this.cards.byRequestId(ctx.match[1]!);
    if (!pending || pending.expiresAt < Date.now() || !manager || card?.managerId !== manager.id) {
      await ctx.answerCbQuery('Надішліть файл ще раз', { show_alert: true });
      await ctx.deleteMessage().catch(() => undefined);
      return;
    }
    const answers = [];
    for (const file of pending.files)
      answers.push(await this.receive(manager, card.requestId, file));
    const question = answers.find((answer) => answer.buttons);
    const failed = answers.find((answer) => !answer.stored && !answer.queued && !answer.buttons);
    await ctx.answerCbQuery(failed ? '' : '👍');
    if (question) {
      await edit(ctx, question).catch(() => undefined);
      return;
    }
    await ctx
      .editMessageText(
        failed ? failed.html : `📎 Додано до запиту #${card.number}: ${answers.length}`,
      )
      .catch(() => undefined);
  }

  /** «Платник · сума» under the question: the waiting files get that payment's caption. */
  async onPayment(ctx: MatchContext): Promise<void> {
    if (!ctx.from || !isPrivate(ctx)) return;
    const userId = BigInt(ctx.from.id);
    const pending = this.paymentChoices.get(userId);
    const manager = await this.managers.findActiveByTelegramId(userId);
    const card = pending && (await this.cards.byRequestId(pending.requestId));
    const order = card ? await this.orderById(card.orderIds[0]) : null;
    const payment = order
      ? await this.prisma.orderRequisite.findFirst({
          where: { id: Number(ctx.match[1]), orderId: order.id },
        })
      : null;
    if (
      !pending ||
      pending.expiresAt < Date.now() ||
      !manager ||
      card?.managerId !== manager.id ||
      !order ||
      !payment
    ) {
      this.paymentChoices.delete(userId);
      await ctx.answerCbQuery('Надішліть файл ще раз', { show_alert: true });
      await ctx.deleteMessage().catch(() => undefined);
      return;
    }
    try {
      await this.attach(
        manager,
        order,
        pending.files,
        receiptCaption(order.orderNumber, payment, manager.name),
      );
    } catch (error) {
      if (!(error instanceof AttachmentStorageError)) throw error;
      await ctx.answerCbQuery('Не вдалося зберегти, спробуйте ще раз', { show_alert: true });
      return;
    }
    this.paymentChoices.delete(userId);
    await ctx.answerCbQuery('👍');
    await ctx
      .editMessageText(`📎 Додано до № ${order.orderNumber}: ${payment.payerName}`)
      .catch(() => undefined);
  }

  async receive(
    manager: Manager,
    requestId: string,
    file: TelegramFileRef,
  ): Promise<ReceiptAnswer> {
    const refusal = fileRefusal(file);
    if (refusal) return { html: refusal };

    // read fresh: completion may have finished while the file travelled
    const card = await this.cards.byRequestId(requestId);
    // completedAt is claimed before the orders exist: with no ids yet the receipt is held as well
    if (!card?.completedAt || card.orderIds.length === 0) {
      // Telegram's media group takes 10 items, so more held files could never be attached
      if ((await this.cards.heldFiles(requestId)).length >= MAX_FILES_PER_UPLOAD) {
        return { html: `⚠️ Максимум ${MAX_FILES_PER_UPLOAD} файлів на замовлення.` };
      }
      await this.cards.holdFile(requestId, file);
      // completion may have stored the ids and attached the held files between the read and the hold
      const late = await this.orderById((await this.cards.byRequestId(requestId))?.orderIds[0]);
      if (!late) {
        return {
          html: '📎 Квитанцію збережено — додамо до замовлення після оформлення',
          stored: true,
        };
      }
      // shortcut: a parallel completion attaching the same held rows can attach this file twice; rare, upgrade to a claim on the rows if it shows up
      return this.storing(late, () => this.attachHeld(manager, requestId, late));
    }

    // a crash between creating the orders and storing their ids leaves completedAt set with no ids
    const order = await this.orderById(card.orderIds[0]);
    if (!order) {
      this.logger.error(
        `Request ${requestId} is completed but has no order to attach a receipt to`,
      );
      return { html: NO_ORDER };
    }
    const payments = await this.prisma.orderRequisite.findMany({
      where: { orderId: order.id },
      orderBy: { id: 'asc' },
    });
    if (payments.length > 1) return this.askPayment(manager, requestId, payments, file);
    const caption = payments[0] && receiptCaption(order.orderNumber, payments[0], manager.name);
    return this.storing(order, () => this.attach(manager, order, [file], caption));
  }

  /** One question per burst of files; files sent while it waits join it. */
  private askPayment(
    manager: Manager,
    requestId: string,
    payments: OrderRequisite[],
    file: TelegramFileRef,
  ): ReceiptAnswer {
    const pending = this.paymentChoices.get(manager.telegramId);
    if (pending?.requestId === requestId && pending.expiresAt > Date.now()) {
      pending.files.push(file);
      return { html: '', queued: true };
    }
    this.paymentChoices.set(manager.telegramId, {
      requestId,
      files: [file],
      expiresAt: Date.now() + CHOICE_TTL_MS,
    });
    return {
      html: '📎 До якого платежу ця квитанція?',
      buttons: payments.map((payment) => [button(paymentButtonLabel(payment), `mp:${payment.id}`)]),
    };
  }

  private async storing(order: Order, store: () => Promise<unknown>): Promise<ReceiptAnswer> {
    try {
      await store();
    } catch (error) {
      if (!(error instanceof AttachmentStorageError)) throw error;
      return { html: '⚠️ Не вдалося зберегти квитанцію, спробуйте ще раз' };
    }
    return { html: `📎 Квитанцію додано до № ${order.orderNumber}`, stored: true };
  }

  private async orderById(id: number | undefined): Promise<Order | null> {
    return id === undefined ? null : this.prisma.order.findUnique({ where: { id } });
  }

  /** At completion: put the receipts sent earlier on the order. The rows go only after they are attached. */
  /** `caption`: the order notice, so the files and the notice are one message in «Оплати». */
  async attachHeld(
    manager: Manager,
    requestId: string,
    order: Order,
    caption?: string,
  ): Promise<void> {
    const held = await this.cards.heldFiles(requestId);
    if (held.length === 0) return;
    await this.attach(
      manager,
      order,
      held.map(({ fileId, filename, mimeType, size, kind }) => ({
        fileId,
        filename,
        mimeType,
        size,
        kind: kind as TelegramFileRef['kind'],
      })),
      caption,
    );
    await this.cards.deleteHeldFiles(held.map(({ id }) => id));
  }

  // group orders attach their files the same way: kept in the storage chat even if the order is deleted
  private attach(
    manager: Manager,
    order: Order,
    files: TelegramFileRef[],
    caption?: string,
  ): Promise<unknown> {
    return this.attachments.saveFromTelegram(
      order,
      files,
      { telegramId: manager.telegramId, name: manager.name },
      true,
      caption,
    );
  }
}
