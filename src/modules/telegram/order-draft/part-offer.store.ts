import { Injectable } from '@nestjs/common';
import type { CreateOrderDto } from '../../orders/dto/create-order.dto';

export type DraftField = keyof CreateOrderDto;

export interface PartOffer {
  data: Partial<Record<DraftField, string>>;
  expiresAt: number;
}

// A regular-order draft on a number that already exists, waiting for the manager to confirm it as
// one more part of that number.
@Injectable()
export class PartOfferStore {
  private readonly offers = new Map<bigint, PartOffer>();

  set(userId: bigint, offer: PartOffer): void {
    this.offers.set(userId, offer);
  }

  // Reads and clears in one step, for whoever answers the offer.
  take(userId: bigint): PartOffer | undefined {
    const offer = this.offers.get(userId);
    this.offers.delete(userId);
    return offer;
  }

  delete(userId: bigint): boolean {
    return this.offers.delete(userId);
  }

  pendingUserIds(now: number): bigint[] {
    return [...this.offers.entries()]
      .filter(([, offer]) => offer.expiresAt > now)
      .map(([id]) => id);
  }
}
