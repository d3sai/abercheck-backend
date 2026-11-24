import { timingSafeEqual } from 'node:crypto';
import type { ThrottlerOptions } from '@nestjs/throttler';
import { digest } from '../../common/guards/api-key.guard';

export const CLIENT_IP_HEADER = 'x-client-ip';
export const CLIENT_IP_TOKEN_HEADER = 'x-client-ip-token';

interface LoginRequest {
  body?: { login?: unknown };
  headers: Record<string, string | string[] | undefined>;
  ip?: string;
}

function loginOf(req: Record<string, unknown>): string {
  const { login } = (req as unknown as LoginRequest).body ?? {};
  return typeof login === 'string' ? login.trim().toLowerCase() : '';
}

// shortcut: with CLIENT_IP_TOKEN unset the header is trusted from anyone (the old behaviour), so
// existing deploys keep working; set it on both services to stop a caller from forging its address.
function trustsClientIp(headers: LoginRequest['headers']): boolean {
  const expected = process.env.CLIENT_IP_TOKEN;
  if (!expected) {
    return true;
  }
  const header = headers[CLIENT_IP_TOKEN_HEADER];
  const provided = Array.isArray(header) ? header[0] : header;
  return !!provided && timingSafeEqual(digest(provided), digest(expected));
}

function ipOf(req: Record<string, unknown>): string {
  const { headers, ip } = req as unknown as LoginRequest;
  const header = headers[CLIENT_IP_HEADER];
  const value = (Array.isArray(header) ? header[0] : header)?.trim();
  if (value && trustsClientIp(headers)) {
    return value;
  }
  return ip ?? 'unknown';
}

export const LOGIN_THROTTLERS: ThrottlerOptions[] = [
  { name: 'login-ip', ttl: 60_000, limit: 5, getTracker: (req) => `${loginOf(req)}|${ipOf(req)}` },
  { name: 'ip', ttl: 60_000, limit: 20, getTracker: (req) => ipOf(req) },
  { name: 'login', ttl: 15 * 60_000, limit: 30, getTracker: (req) => loginOf(req) },
];
