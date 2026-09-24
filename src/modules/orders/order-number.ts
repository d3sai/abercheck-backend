const ORDER_NUMBER = /(?<!\d)\d{4}-\d{6}(?!\d)/;
const PART_NUMBER = /(?<!\d)\d{4}-\d{6}(?!\d)(?:\s*\(\d+\))?/;
const PART_SUFFIX = /\((\d+)\)$/;

export function normalizeOrderNumber(raw: string): string {
  return ORDER_NUMBER.exec(raw)?.[0] ?? raw.trim();
}

// One 1C number can carry several orders (parts of a split payment): the first keeps the bare
// number, the next ones get "(1)", "(2)", ... The bare number is the key payments are tracked by.
export function baseNumberOf(orderNumber: string): string {
  return orderNumber.replace(PART_SUFFIX, '');
}

export function normalizeBaseNumber(raw: string): string {
  return baseNumberOf(normalizeOrderNumber(raw));
}

export function normalizePartNumber(raw: string): string {
  const match = PART_NUMBER.exec(raw)?.[0];
  return match ? match.replace(/\s+/g, '') : raw.trim();
}

export function partIndexOf(orderNumber: string): number {
  const match = PART_SUFFIX.exec(orderNumber);
  return match ? Number(match[1]) : 0;
}

export function partNumber(baseNumber: string, index: number): string {
  return index === 0 ? baseNumber : `${baseNumber}(${index})`;
}

// A minus closing has no 1C number of its own. Plain digits, so admins can copy it into /attach or
// /refund exactly as shown; it can never look like a 1C number (0000-000000).
export function generateClosingOrderNumber(): string {
  return String(Date.now());
}
