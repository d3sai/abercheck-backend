import { Injectable } from '@nestjs/common';
import type { RequisitesPlan } from './requisites.parser';

export interface RequisitesDraft {
  plan: RequisitesPlan;
  /** The original message, kept for the "це звичайне замовлення" escape hatch. */
  text: string;
  /** The single number already exists: this becomes one more part of it. */
  addPart: boolean;
  /** Numbers left out of a group because they already exist. */
  skipped: string[];
  expiresAt: number;
}

// Two pieces of state for the "кілька номерів / реквізити" mode, per Telegram user: whether the
// mode is armed (the very next message is read as a requisites report), and the parsed preview
// waiting for the manager to confirm, edit, or fall back to a regular order.
@Injectable()
export class RequisitesDraftStore {
  private readonly until = new Map<bigint, number>();
  private readonly drafts = new Map<bigint, RequisitesDraft>();

  arm(userId: bigint, expiresAt: number): void {
    this.until.set(userId, expiresAt);
  }

  isArmed(userId: bigint, now = Date.now()): boolean {
    return (this.until.get(userId) ?? 0) > now;
  }

  disarm(userId: bigint): boolean {
    return this.until.delete(userId);
  }

  setDraft(userId: bigint, draft: RequisitesDraft): void {
    this.drafts.set(userId, draft);
  }

  // Reads and clears in one step, for whoever answers the preview.
  takeDraft(userId: bigint): RequisitesDraft | undefined {
    const draft = this.drafts.get(userId);
    this.drafts.delete(userId);
    return draft;
  }

  clearDraft(userId: bigint): boolean {
    return this.drafts.delete(userId);
  }

  // Another flow was started, or the manager cancelled: neither the armed mode nor a pending
  // preview should survive.
  leave(userId: bigint): void {
    this.disarm(userId);
    this.clearDraft(userId);
  }

  pendingUserIds(now: number): bigint[] {
    const ids = new Set<bigint>();
    for (const [id, until] of this.until) {
      if (until > now) ids.add(id);
    }
    for (const [id, draft] of this.drafts) {
      if (draft.expiresAt > now) ids.add(id);
    }
    return [...ids];
  }
}
