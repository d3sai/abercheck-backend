import { Injectable } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { MAX_FILES_PER_UPLOAD } from '../../attachments/attachments.constants';
import { type Manager, type Order, OrderType } from '../../../generated/prisma/client';
import { CreateOrderDto } from '../../orders/dto/create-order.dto';
import { OrderNumberTakenError } from '../../orders/orders.errors';
import {
  type OrderWithManager,
  type OrderWithPaid,
  OrdersService,
} from '../../orders/orders.service';
import type { BotReply } from '../core/bot-reply';
import { button } from '../core/bot-reply';
import { escapeHtml, formatMoneyIn } from '../core/format';
import { adminOrderCreatedMessage } from '../notifications/order-templates';
import { DraftAttachmentNotifier } from './draft-attachment-notifier';
import {
  detectCurrency,
  parseExchangeRate,
  parseFreeform,
  parseMoney,
  parseOrderNumber,
  type ParseResult,
  parseTemplate,
  parseText,
} from './order-draft.parsers';
import { type DraftField, type PartOffer, PartOfferStore } from './part-offer.store';
import { PendingFilesStore } from './pending-files.store';
import { hasMultipleOrdersOrRequisites } from './requisites.parser';
import { DraftAction } from './draft-action';

interface FieldSpec {
  field: DraftField;
  label: string;
  optional: boolean;
  parse: (input: string) => ParseResult;
}

const FIELDS: readonly FieldSpec[] = [
  { field: 'orderNumber', label: 'Номер', optional: false, parse: parseOrderNumber },
  { field: 'clientName', label: 'ФОП', optional: false, parse: parseText(255) },
  { field: 'amountDue', label: 'Сума', optional: false, parse: parseMoney },
  { field: 'exchangeRate', label: 'Курс', optional: true, parse: parseExchangeRate },
  { field: 'comment', label: 'Коментар', optional: true, parse: parseText(2000) },
];

const PART_OFFER_TTL_MS = 10 * 60_000;

function pluralizeFiles(count: number): string {
  const mod10 = count % 10;
  const mod100 = count % 100;
  if (mod100 >= 11 && mod100 <= 14) return 'файлів';
  if (mod10 === 1) return 'файл';
  if (mod10 >= 2 && mod10 <= 4) return 'файли';
  return 'файлів';
}

@Injectable()
export class OrderCreationFlowService {
  constructor(
    private readonly orders: OrdersService,
    private readonly pendingFiles: PendingFilesStore,
    private readonly partOffers: PartOfferStore,
    private readonly notifier: DraftAttachmentNotifier,
  ) {}

  hint(): BotReply {
    const fields = FIELDS.map((f) => f.label + (f.optional ? '' : '*')).join(', ');
    const example = [
      '0000-066717',
      'Чернявський Владислав',
      '6 158,41 грн',
      '44,9',
      'Терміново',
    ].join('\n');
    return {
      html: [
        '📝 <b>Нове замовлення</b>',
        'Кожне поле з нового рядка:',
        `${fields} (* — обов'язкове).`,
        '',
        `<pre>${example}</pre>`,
        'Суму в доларах пишіть зі знаком $: <code>150 $</code>.',
        '',
        `Файли (до ${MAX_FILES_PER_UPLOAD}) додавайте разом із текстом або перед ним.`,
      ].join('\n'),
    };
  }

  extractFields(text: string): Record<string, string> | null {
    const labeled = parseTemplate(text, FIELDS);
    return Object.keys(labeled).length > 0 ? labeled : parseFreeform(text);
  }

  needsRequisitesButton(text: string): boolean {
    return (
      Object.keys(parseTemplate(text, FIELDS)).length === 0 && hasMultipleOrdersOrRequisites(text)
    );
  }

  async process(manager: Manager, raw: Record<string, string>): Promise<BotReply> {
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

    data.currency = detectCurrency(raw.amountDue ?? '');
    const existing = data.orderNumber ? await this.orders.findWithBalance(data.orderNumber) : null;
    if (existing && existing.order.currency !== data.currency) {
      return {
        html: `⚠️ Номер № ${escapeHtml(existing.order.orderNumber)} вже є в системі в іншій валюті — частину в іншій валюті додати не можна.`,
      };
    }
    return existing
      ? this.offerPart(manager, data, existing)
      : this.createOrder(manager, data, false);
  }

  async createOrder(
    manager: Manager,
    data: Partial<Record<DraftField, string>>,
    addPart: boolean,
  ): Promise<BotReply> {
    const dto = plainToInstance(CreateOrderDto, { orderType: OrderType.REGULAR, ...data });
    if (validateSync(dto).length > 0) {
      return { html: '⚠️ Дані замовлення некоректні. Спробуйте ще раз.' };
    }

    const files = this.pendingFiles.list(manager.telegramId);
    const hasFiles = files.length > 0;
    try {
      const order = await this.orders.create(manager.id, dto, { notify: !hasFiles, addPart });
      this.pendingFiles.clear(manager.telegramId);
      if (hasFiles) {
        await this.notifier.notify(order, manager, files, adminOrderCreatedMessage(order, manager));
      }
      return this.createdReply(order);
    } catch (error) {
      if (error instanceof OrderNumberTakenError) {
        return { html: `⚠️ Замовлення № ${escapeHtml(error.orderNumber)} вже є в системі.` };
      }
      throw error;
    }
  }

  nudge(userId: bigint): BotReply | null {
    const files = this.pendingFiles.list(userId);
    if (files.length === 0) {
      return null;
    }
    return {
      html: [
        `У вас ${files.length} ${pluralizeFiles(files.length)} без даних замовлення.`,
        'Надішліть дані замовлення одним повідомленням (формат — /new) або /cancel.',
      ].join('\n'),
    };
  }

  private offerPart(
    manager: Manager,
    data: Partial<Record<DraftField, string>>,
    { order, amountPaid }: OrderWithPaid<OrderWithManager>,
  ): BotReply {
    const offer: PartOffer = { data, expiresAt: Date.now() + PART_OFFER_TTL_MS };
    this.partOffers.set(manager.telegramId, offer);
    return {
      html: [
        `⚠️ Номер № <b>${escapeHtml(order.orderNumber)}</b> вже є в системі.`,
        `${escapeHtml(order.clientName)} · ${formatMoneyIn(order.amountDue, order.currency)} · сплачено ${formatMoneyIn(amountPaid, order.currency)}`,
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

  private createdReply(order: Order): BotReply {
    const label =
      order.orderNumber === order.baseNumber ? '✅ Замовлення' : '➕ Частину замовлення';
    return {
      html: [
        `${label} № <b>${escapeHtml(order.orderNumber)}</b> створено — повідомлю про оплату.`,
        `${escapeHtml(order.clientName)} · ${formatMoneyIn(order.amountDue, order.currency)}`,
      ].join('\n'),
    };
  }
}
