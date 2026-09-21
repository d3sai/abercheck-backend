import { Injectable } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import {
  ALLOWED_MIME_TYPES,
  MAX_FILES_PER_UPLOAD,
  MAX_FILE_SIZE_BYTES,
  TELEGRAM_CAPTION_LIMIT,
} from '../../attachments/attachments.constants';
import { AttachmentsService, type TelegramFileRef } from '../../attachments/attachments.service';
import { type Manager, type Order, OrderType } from '../../../generated/prisma/client';
import { CreateOrderDto } from '../../orders/dto/create-order.dto';
import { OrderNumberTakenError } from '../../orders/orders.errors';
import {
  type OrderWithManager,
  type OrderWithPaid,
  OrdersService,
} from '../../orders/orders.service';
import { type BotReply, button } from '../core/bot-reply';
import { escapeHtml, formatMoney } from '../core/format';
import { TelegramSender } from '../core/telegram-sender';
import { adminOrderCreatedMessage } from '../notifications/order-templates';
import {
  parseExchangeRate,
  parseFreeform,
  parseMoney,
  parseOrderNumber,
  type ParseResult,
  parseTemplate,
  parseText,
} from './order-draft.parsers';

type DraftField = keyof CreateOrderDto;

interface FieldSpec {
  field: DraftField;
  label: string;
  optional: boolean;
  parse: (input: string) => ParseResult;
}

const FIELDS: readonly FieldSpec[] = [
  { field: 'orderNumber', label: 'Номер', optional: true, parse: parseOrderNumber },
  { field: 'clientName', label: 'ФОП', optional: false, parse: parseText(255) },
  { field: 'amountDue', label: 'Сума', optional: false, parse: parseMoney },
  { field: 'exchangeRate', label: 'Курс', optional: true, parse: parseExchangeRate },
  { field: 'comment', label: 'Коментар', optional: true, parse: parseText(2000) },
];

export const DraftAction = {
  AddPart: 'part:add',
  SkipPart: 'part:skip',
} as const;

// How long a manager has to confirm adding a part to an already existing number.
const PART_OFFER_TTL_MS = 10 * 60_000;

interface PartOffer {
  data: Partial<Record<DraftField, string>>;
  expiresAt: number;
}

function pluralizeFiles(count: number): string {
  const mod10 = count % 10;
  const mod100 = count % 100;
  if (mod100 >= 11 && mod100 <= 14) return 'файлів';
  if (mod10 === 1) return 'файл';
  if (mod10 >= 2 && mod10 <= 4) return 'файли';
  return 'файлів';
}

@Injectable()
export class OrderDraftService {
  private readonly pendingFiles = new Map<bigint, TelegramFileRef[]>();
  private readonly partOffers = new Map<bigint, PartOffer>();

  constructor(
    private readonly orders: OrdersService,
    private readonly attachments: AttachmentsService,
    private readonly sender: TelegramSender,
  ) {}

  hint(type: OrderType): BotReply {
    const isMinus = type === OrderType.MINUS_CLOSING;
    const title = isMinus ? 'Закриття мінусу' : 'Нове замовлення';
    const fields = isMinus ? FIELDS.filter((f) => f.field !== 'orderNumber') : FIELDS;
    const lines = fields.map(
      (f) => f.label + (f.field === 'orderNumber' || !f.optional ? '*' : ''),
    );
    const example = [
      ...(isMinus ? [] : ['0000-066717']),
      'Чернявський Владислав',
      '6 158,41 грн',
      '44,9',
      'Терміново',
    ].join('\n');
    return {
      html: [
        `📝 <b>${title}</b>`,
        'Надішліть одним повідомленням, кожне значення з нового рядка',
        `Файли (до ${MAX_FILES_PER_UPLOAD}) — разом із повідомленням або перед ним`,
        ...(isMinus
          ? []
          : ['Номер уже є в системі? Бот запропонує додати ще одну частину до нього.']),
        '',
        "Порядок рядків (* — обов'язкове):",
        lines.join(', '),
        '',
        'Наприклад:',
        `<pre>${example}</pre>`,
      ].join('\n'),
    };
  }

  async handleText(manager: Manager, text: string): Promise<BotReply | null> {
    const raw = this.extractFields(text);
    if (!raw) {
      return this.nudge(manager.telegramId);
    }
    return this.process(manager, raw);
  }

  private extractFields(text: string): Record<string, string> | null {
    const labeled = parseTemplate(text, FIELDS);
    return Object.keys(labeled).length > 0 ? labeled : parseFreeform(text);
  }

  async addFile(manager: Manager, file: TelegramFileRef, caption?: string): Promise<BotReply> {
    if (!ALLOWED_MIME_TYPES.has(file.mimeType)) {
      return { html: '⚠️ Такий тип файлу не підтримується. Додайте фото, PDF або зображення.' };
    }
    if (file.size > MAX_FILE_SIZE_BYTES) {
      return { html: '⚠️ Файл завеликий. Максимум 10 МБ.' };
    }
    if ((this.pendingFiles.get(manager.telegramId)?.length ?? 0) >= MAX_FILES_PER_UPLOAD) {
      return { html: `⚠️ Максимум ${MAX_FILES_PER_UPLOAD} файлів на замовлення.` };
    }

    const files = this.bufferFile(manager.telegramId, file);
    const text = caption?.trim();
    const raw = text ? this.extractFields(text) : null;
    if (raw) {
      return this.process(manager, raw);
    }
    return {
      html: `📎 Додано «${escapeHtml(file.filename)}» (${files.length}/${MAX_FILES_PER_UPLOAD}).`,
    };
  }

  cancel(userId: bigint): BotReply {
    const hadFiles = this.pendingFiles.delete(userId);
    const hadOffer = this.partOffers.delete(userId);
    return { html: hadFiles || hadOffer ? 'Скасовано.' : 'Нема чого скасовувати.' };
  }

  async addPart(manager: Manager): Promise<BotReply> {
    const offer = this.partOffers.get(manager.telegramId);
    this.partOffers.delete(manager.telegramId);
    if (!offer || offer.expiresAt < Date.now()) {
      return { html: '⚠️ Немає даних для додавання. Надішліть замовлення ще раз.' };
    }
    return this.createOrder(manager, offer.data, true);
  }

  skipPart(userId: bigint): BotReply {
    this.partOffers.delete(userId);
    return { html: 'Скасовано.' };
  }

  private async process(manager: Manager, raw: Record<string, string>): Promise<BotReply> {
    const data: Partial<Record<DraftField, string>> = {};
    const errors: string[] = [];

    for (const field of FIELDS) {
      const value = raw[field.field]?.trim() ?? '';
      if (value.length === 0) {
        if (!field.optional) {
          errors.push(`«${field.label}» — поле обов'язкове.`);
        }
        continue;
      }
      const result = field.parse(value);
      if (!result.ok) {
        errors.push(`«${field.label}»: ${result.error}`);
        continue;
      }
      data[field.field] = result.value;
    }

    if (errors.length > 0) {
      return {
        html: ['⚠️ Виправте та надішліть ще раз:', ...errors.map((e) => `• ${e}`)].join('\n'),
      };
    }

    const existing = data.orderNumber ? await this.orders.findWithBalance(data.orderNumber) : null;
    return existing ? this.offerPart(manager, data, existing) : this.createOrder(manager, data);
  }

  // An order on a taken number is a duplicate unless the manager confirms it is one more part of
  // the same payment; the draft waits for that answer.
  private offerPart(
    manager: Manager,
    data: Partial<Record<DraftField, string>>,
    { order, amountPaid }: OrderWithPaid<OrderWithManager>,
  ): BotReply {
    this.partOffers.set(manager.telegramId, { data, expiresAt: Date.now() + PART_OFFER_TTL_MS });
    return {
      html: [
        `⚠️ Номер № <b>${escapeHtml(order.orderNumber)}</b> вже є в системі.`,
        `${escapeHtml(order.clientName)} · ${formatMoney(order.amountDue)} грн · сплачено ${formatMoney(amountPaid)} грн`,
        '',
        'Додати це замовлення ще однією частиною цього номера? Оплата за номером покриє всі частини.',
      ].join('\n'),
      buttons: [
        [
          button('➕ Додати частину', DraftAction.AddPart),
          button('✖ Скасувати', DraftAction.SkipPart),
        ],
      ],
    };
  }

  private async createOrder(
    manager: Manager,
    data: Partial<Record<DraftField, string>>,
    addPart = false,
  ): Promise<BotReply> {
    const orderType = data.orderNumber ? OrderType.REGULAR : OrderType.MINUS_CLOSING;
    const dto = plainToInstance(CreateOrderDto, { orderType, ...data });
    if (validateSync(dto).length > 0) {
      return { html: '⚠️ Дані замовлення некоректні. Спробуйте ще раз.' };
    }

    const files = this.pendingFiles.get(manager.telegramId) ?? [];
    const hasFiles = files.length > 0;
    try {
      const order = await this.orders.create(manager.id, dto, { notify: !hasFiles, addPart });
      this.pendingFiles.delete(manager.telegramId);
      if (hasFiles) {
        await this.notifyWithAttachment(order, manager, files);
      }
      return this.createdReply(order);
    } catch (error) {
      if (error instanceof OrderNumberTakenError) {
        return { html: `⚠️ Замовлення № ${escapeHtml(error.orderNumber)} вже є в системі.` };
      }
      throw error;
    }
  }

  private createdReply(order: Order): BotReply {
    const label =
      order.orderType === OrderType.MINUS_CLOSING
        ? '➖ Закриття мінусу'
        : order.orderNumber === order.baseNumber
          ? '✅ Замовлення'
          : '➕ Частину замовлення';
    return {
      html: [
        `${label} № <b>${escapeHtml(order.orderNumber)}</b> створено — повідомлю про оплату.`,
        `${escapeHtml(order.clientName)} · ${formatMoney(order.amountDue)} грн`,
      ].join('\n'),
    };
  }

  private nudge(userId: bigint): BotReply | null {
    const files = this.pendingFiles.get(userId);
    if (!files?.length) {
      return null;
    }
    return {
      html: [
        `У вас ${files.length} ${pluralizeFiles(files.length)} без даних замовлення.`,
        'Надішліть дані замовлення одним повідомленням (формат — /new) або /cancel.',
      ].join('\n'),
    };
  }

  private bufferFile(userId: bigint, file: TelegramFileRef): TelegramFileRef[] {
    const files = this.pendingFiles.get(userId) ?? [];
    files.push(file);
    this.pendingFiles.set(userId, files);
    return files;
  }

  // Merges the "order created" admin notice into the file's caption so admins get one message, not two.
  private async notifyWithAttachment(
    order: Order,
    manager: Manager,
    files: TelegramFileRef[],
  ): Promise<void> {
    const notice = adminOrderCreatedMessage(order, manager);
    const canMergeCaption = notice.length <= TELEGRAM_CAPTION_LIMIT;
    let merged = false;
    try {
      await this.attachments.saveFromTelegram(
        order,
        files,
        { telegramId: manager.telegramId, name: manager.name },
        true,
        canMergeCaption ? notice : undefined,
      );
      merged = canMergeCaption;
    } finally {
      if (!merged) {
        await this.sender.sendToAdmins(notice);
      }
    }
  }
}
