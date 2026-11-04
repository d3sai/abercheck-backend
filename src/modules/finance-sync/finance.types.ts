// Mirrors finance-backend src/modules/internal/internal-requests.dto.ts. Keep in step by hand.
export type RequestKind = 'our_fop' | 'foreign_fop' | 'card' | 'minus' | 'dropship';
export type RequestStatus = 'pending' | 'accepted' | 'cancelled';
export type RequestWarning = 'multi_order' | 'sum_mismatch' | 'iban_invalid' | 'card_invalid';

export interface FinanceOrderView {
  orderNumber: string;
  amount: string;
  exchangeRate: string | null;
}

export interface FinancePayoutView {
  method: 'iban' | 'card';
  recipientName: string | null;
  iban: string | null;
  taxId: string | null;
  purpose: string | null;
  amount: string | null;
  warnings: RequestWarning[];
}

export interface FinanceRequestView {
  id: string;
  number: string;
  status: RequestStatus;
  kind: RequestKind | null;
  sum: string;
  orderNumber: string | null;
  orders: FinanceOrderView[];
  exchangeRate: string | null;
  comment: string | null;
  officialDocs: boolean | null;
  clientLabel: string | null;
  sheetUrl: string | null;
  withPercent: boolean | null;
  isPaid: boolean;
  requestDate: string;
  responseDate: string | null;
  cancelledAt: string | null;
  fopLabel: string | null;
  responderName: string | null;
  payouts: FinancePayoutView[];
  warnings: RequestWarning[];
  managerChatId: number;
  groupChatId: number;
  groupMessageId: number;
}

export interface FinanceFop {
  fopId: number;
  label: string;
  leftMonthWithReserve: string | null;
}

export interface FinanceFops {
  limitsEnabled: boolean;
  limitsStatus: 'ok' | 'disabled' | 'unavailable';
  project: string | null;
  fops: FinanceFop[];
}

// `orders` for fop/card kinds, `sum` for minus/dropship (finance validates the pairing).
export interface CreateRequestBody {
  requesterTelegramId: number;
  requesterName: string;
  kind: RequestKind;
  orders?: { orderNumber: string; amount: number; exchangeRate?: number | null }[];
  sum?: number;
  exchangeRate?: number | null;
  comment?: string | null;
  officialDocs: boolean;
  clientLabel?: string | null;
  sheetUrl?: string | null;
  withPercent?: boolean | null;
  groupChatId: number;
  groupMessageId: number;
}

export interface FinanceEvent {
  type: 'accepted' | 'cancelled' | 'edited' | 'paid' | 'message';
  requestId: string;
  request: FinanceRequestView;
  message?: { messageId: string; author: string; body: string | null; fileName: string | null };
}

/** `code` is finance's `error` field, or `'network'` / `'timeout'` (status 0) when no answer came. */
export class FinanceApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(`finance ${status || ''} ${code}`.replace('  ', ' '));
    this.name = 'FinanceApiError';
  }
}
