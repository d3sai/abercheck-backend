const ORDER_NUMBER = /(?<!\d)\d{4}-\d{6}(?!\d)/;
const PART_NUMBER = /(?<!\d)\d{4}-\d{6}(?!\d)(?:\s*\(\d+\))?/;
const PART_SUFFIX = /\((\d+)\)$/;

export function normalizeOrderNumber(raw: string): string {
  return ORDER_NUMBER.exec(raw)?.[0] ?? raw.trim();
}

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

export function generateClosingOrderNumber(): string {
  return String(Date.now());
}
