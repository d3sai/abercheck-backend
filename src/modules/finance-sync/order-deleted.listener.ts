import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { ManagersService } from '../managers/managers.service';
import { type OrderDeleted, OrderEvents } from '../orders/order.events';
import { OrdersService } from '../orders/orders.service';
import { FinanceClient } from './finance.client';
import { RequestCardsRepository } from './request-cards.repository';
import { RequestSyncService } from './request-sync.service';

@Injectable()
export class OrderDeletedListener {
  private readonly logger = new Logger(OrderDeletedListener.name);

  constructor(
    private readonly cards: RequestCardsRepository,
    private readonly orders: OrdersService,
    private readonly managers: ManagersService,
    private readonly finance: FinanceClient,
    private readonly sync: RequestSyncService,
  ) {}

  @OnEvent(OrderEvents.Deleted, { async: true })
  async onDeleted({ orderId }: OrderDeleted): Promise<void> {
    try {
      const card = await this.cards.byOrderId(orderId);
      if (!card) return;
      if ((await this.orders.numbersByIds(card.orderIds)).length > 0) return;
      const manager = await this.managers.findById(card.managerId);
      if (!manager) return;
      const view = await this.finance.cancel(card.requestId, {
        actorTelegramId: Number(manager.telegramId),
        actorName: manager.name,
      });
      await this.sync.renderManager(card, view);
      await this.sync.renderGroup(card, view);
    } catch (error) {
      this.logger.error(`Failed to cancel the finance request of deleted order #${orderId}`, error);
    }
  }
}
