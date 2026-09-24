import { Injectable } from '@nestjs/common';
import { DraftModeStore } from './draft-mode.store';
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

// The "кілька номерів / реквізити" mode's state.
@Injectable()
export class RequisitesDraftStore extends DraftModeStore<RequisitesDraft> {}
