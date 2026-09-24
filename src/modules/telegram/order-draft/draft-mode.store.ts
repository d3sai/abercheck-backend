// Two pieces of state for a one-message draft mode, per Telegram user: whether the mode is armed
// (the very next message is read by that mode's parser), and the parsed preview waiting for the
// manager to confirm or edit it.
export class DraftModeStore<T extends { expiresAt: number }> {
  private readonly until = new Map<bigint, number>();
  private readonly drafts = new Map<bigint, T>();

  arm(userId: bigint, expiresAt: number): void {
    this.until.set(userId, expiresAt);
  }

  isArmed(userId: bigint, now = Date.now()): boolean {
    return (this.until.get(userId) ?? 0) > now;
  }

  disarm(userId: bigint): boolean {
    return this.until.delete(userId);
  }

  setDraft(userId: bigint, draft: T): void {
    this.drafts.set(userId, draft);
  }

  // Reads and clears in one step, for whoever answers the preview.
  takeDraft(userId: bigint): T | undefined {
    const draft = this.drafts.get(userId);
    this.drafts.delete(userId);
    return draft;
  }

  clearDraft(userId: bigint): boolean {
    return this.drafts.delete(userId);
  }

  // Another flow was started, or the manager cancelled: neither the armed mode nor a pending
  // preview should survive. Reports whether there was anything to drop.
  leave(userId: bigint): boolean {
    const hadWaiting = this.disarm(userId);
    const hadDraft = this.clearDraft(userId);
    return hadWaiting || hadDraft;
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
