/** A payment as it sits in the card's JSON column: money as a decimal string, time as ISO. */
export interface StoredPayment {
  payerName: string | null;
  account: string | null;
  amount: string;
  paidAt: string;
}

/** The column is only ever written by us; a malformed value counts as no payments. */
export function storedPayments(value: unknown): StoredPayment[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (row): row is StoredPayment =>
      typeof row === 'object' &&
      row !== null &&
      typeof (row as StoredPayment).amount === 'string' &&
      typeof (row as StoredPayment).paidAt === 'string' &&
      !Number.isNaN(new Date((row as StoredPayment).paidAt).getTime()),
  );
}
