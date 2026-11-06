import { HttpStatus, Injectable } from '@nestjs/common';
import type { Manager } from '../../generated/prisma/client';
import { ApiError } from '../../common/api-error';
import { OrderNumberTakenError } from '../orders/orders.errors';
import { CashDraftService } from '../telegram/order-draft/cash-draft.service';
import type { CashPlan } from '../telegram/order-draft/cash.parser';
import { ForeignDraftService } from '../telegram/order-draft/foreign-draft.service';
import type { ForeignPlan } from '../telegram/order-draft/foreign.parser';
import { KitDraftService } from '../telegram/order-draft/kit-draft.service';
import type { KitPlan } from '../telegram/order-draft/kit.parser';
import type { OrderPlan } from './miniapp.dto';

export interface DirectOrdersResult {
  /** Numbers created as new orders. */
  orderNumbers: string[];
  /** Numbers the system already had: the payment was only recorded or the notice sent. */
  skipped: string[];
  note?: string;
}

const conflict = (code: string, message: string): ApiError =>
  new ApiError(HttpStatus.CONFLICT, code, message);

/** Kit, cash and foreign payments from the form: the text modes' check and create steps, without the draft. */
@Injectable()
export class DirectOrdersService {
  constructor(
    private readonly kit: KitDraftService,
    private readonly cash: CashDraftService,
    private readonly foreign: ForeignDraftService,
  ) {}

  async create(manager: Manager, order: OrderPlan): Promise<DirectOrdersResult> {
    try {
      switch (order.kind) {
        case 'kit':
          return await this.createKit(manager, order.plan);
        case 'cash':
          return await this.createCash(manager, order.plan);
        case 'foreign':
          return await this.createForeign(manager, order.plan);
      }
    } catch (error) {
      if (error instanceof OrderNumberTakenError) {
        throw conflict(
          'order-taken',
          `Номер ${error.orderNumber} щойно з'явився в системі. Перевірте форму й надішліть ще раз.`,
        );
      }
      throw error;
    }
  }

  private async createKit(manager: Manager, plan: KitPlan): Promise<DirectOrdersResult> {
    const existing = await this.kit.existingNumbers(plan);
    const created = await this.kit.createOrders(manager, plan, existing);
    await this.kit.announce(manager, plan, existing, created);
    return {
      orderNumbers: plan.items
        .map((item) => item.number)
        .filter((number) => !existing.includes(number)),
      skipped: existing,
      ...(existing.length > 0 && {
        note: 'Частина номерів уже є в системі, їх не створено вдруге.',
      }),
    };
  }

  private async createCash(manager: Manager, plan: CashPlan): Promise<DirectOrdersResult> {
    const check = await this.cash.check(plan);
    if (!check.ok) {
      throw check.alreadyRecorded
        ? conflict('already-recorded', 'Цю оплату вже зареєстровано.')
        : conflict('order-conflict', check.errors.join(' '));
    }
    const exists = check.existing.length > 0;
    await this.cash.record(manager, plan, exists);
    return exists
      ? {
          orderNumbers: [],
          skipped: [plan.number],
          note: 'Замовлення вже є в системі, оплату записано до нього.',
        }
      : { orderNumbers: [plan.number], skipped: [] };
  }

  private async createForeign(manager: Manager, plan: ForeignPlan): Promise<DirectOrdersResult> {
    const exists = await this.foreign.exists(plan);
    const created = await this.foreign.createOrder(manager, plan, exists);
    await this.foreign.announce(manager, plan, exists, created);
    return exists
      ? {
          orderNumbers: [],
          skipped: [plan.number],
          note: 'Замовлення вже є в системі, адмінам надіслано шаблон.',
        }
      : { orderNumbers: [plan.number], skipped: [] };
  }
}
