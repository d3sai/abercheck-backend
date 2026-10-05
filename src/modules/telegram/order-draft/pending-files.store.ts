import { Injectable } from '@nestjs/common';
import type { TelegramFileRef } from '../../attachments/attachments.service';

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

  take(userId: bigint): TelegramFileRef[] {
    const files = this.list(userId);
    this.files.delete(userId);
    return files;
  }

  clear(userId: bigint): boolean {
    return this.files.delete(userId);
  }

  pendingUserIds(): bigint[] {
    return [...this.files.keys()];
  }
}
