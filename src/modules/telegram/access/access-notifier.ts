import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { ManagerStatus } from '../../../generated/prisma/client';
import { type ManagerAccessChanged, ManagerEvents } from '../../managers/manager.events';
import { TelegramSender } from '../core/telegram-sender';
import { decisionNotice } from './access.messages';

@Injectable()
export class AccessNotifier {
  private readonly logger = new Logger(AccessNotifier.name);

  constructor(private readonly sender: TelegramSender) {}

  @OnEvent(ManagerEvents.AccessChanged, { async: true })
  async onAccessChanged({ manager }: ManagerAccessChanged): Promise<void> {
    if (manager.status === ManagerStatus.PENDING) {
      return;
    }
    try {
      await this.sender.send(
        manager.telegramId,
        decisionNotice(manager),
        undefined,
        manager.status === ManagerStatus.ACTIVE,
      );
    } catch (error) {
      this.logger.error(`Failed to notify manager #${manager.id} about access decision`, error);
    }
  }
}
