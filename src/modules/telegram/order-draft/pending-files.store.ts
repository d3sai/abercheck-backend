import { Injectable } from '@nestjs/common';
import type { TelegramFileRef } from '../../attachments/attachments.service';

// Files a manager has sent before (or without) the order data that should carry them, keyed by
// Telegram user id. Shared by the regular-order and requisites drafts: whichever flow ends up
// creating the order attaches whatever is buffered here.
@Injectable()
export class PendingFilesStore {
  private readonly files = new Map<bigint, TelegramFileRef[]>();

  add(userId: bigint, file: TelegramFileRef): TelegramFileRef[] {
    const files = this.files.get(userId) ?? [];
    files.push(file);
    this.files.set(userId, files);
    return files;
  }

  list(userId: bigint): TelegramFileRef[] {
    return this.files.get(userId) ?? [];
  }

  // Reads and clears in one step, for whichever flow consumes the buffer to create an order.
  take(userId: bigint): TelegramFileRef[] {
    const files = this.list(userId);
    this.files.delete(userId);
    return files;
  }

  clear(userId: bigint): boolean {
    return this.files.delete(userId);
  }

  // Every user with buffered files; a file never expires on its own, so this is unconditional.
  pendingUserIds(): bigint[] {
    return [...this.files.keys()];
  }
}
