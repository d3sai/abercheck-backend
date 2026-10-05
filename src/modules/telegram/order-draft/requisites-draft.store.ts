import { Injectable } from '@nestjs/common';
import { DraftModeStore } from './draft-mode.store';
import type { RequisitesPlan } from './requisites.parser';

export interface RequisitesDraft {
  plan: RequisitesPlan;
  text: string;
  addPart: boolean;
  skipped: string[];
  expiresAt: number;
}

@Injectable()
export class RequisitesDraftStore extends DraftModeStore<RequisitesDraft> {}
