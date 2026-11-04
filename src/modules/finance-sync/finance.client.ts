import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { optionalNonBlank } from '../../common/config/optional-config';
import {
  CreateRequestBody,
  FinanceApiError,
  FinanceFops,
  FinanceRequestView,
} from './finance.types';

const TIMEOUT_MS = 10_000;

function filenameOf(disposition: string | null): string {
  const encoded = /filename\*=UTF-8''([^;]+)/i.exec(disposition ?? '')?.[1];
  if (encoded) {
    try {
      return decodeURIComponent(encoded);
    } catch {
      // fall through to the plain form
    }
  }
  return /filename="?([^";]+)"?/i.exec(disposition ?? '')?.[1] ?? 'file';
}

@Injectable()
export class FinanceClient {
  constructor(private readonly config: ConfigService) {}

  async create(body: CreateRequestBody): Promise<{ id: string; number: string }> {
    const send = () =>
      this.call(
        'POST',
        '/internal/requests',
        body,
        (res) => res.json() as Promise<{ id: string; number: string }>,
      );
    try {
      return await send();
    } catch (error) {
      // safe: finance answers a repeat with the same group message as the stored request
      if (
        error instanceof FinanceApiError &&
        (error.code === 'network' || error.code === 'timeout')
      ) {
        return send();
      }
      throw error;
    }
  }

  fops(requesterTelegramId: number): Promise<FinanceFops> {
    return this.call(
      'GET',
      `/internal/fops?requesterTelegramId=${requesterTelegramId}`,
      undefined,
      (res) => res.json() as Promise<FinanceFops>,
    );
  }

  async accept(
    id: string,
    body: {
      responderTelegramId: number;
      fopId?: number;
      payoutsText?: string;
      exchangeRate?: number | null;
    },
  ): Promise<FinanceRequestView> {
    return (await this.post(id, 'accept', body)).request;
  }

  async cancel(
    id: string,
    body: { actorTelegramId: number; actorName: string },
  ): Promise<FinanceRequestView> {
    return (await this.post(id, 'cancel', body)).request;
  }

  get(id: string): Promise<{ request: FinanceRequestView }> {
    return this.call(
      'GET',
      `/internal/requests/${encodeURIComponent(id)}`,
      undefined,
      (res) => res.json() as Promise<{ request: FinanceRequestView }>,
    );
  }

  async postMessage(
    id: string,
    body: { authorTelegramId: number; authorName: string; body: string; clientId: string },
  ): Promise<void> {
    await this.post(id, 'messages', body);
  }

  file(
    id: string,
    messageId: string,
  ): Promise<{ data: Buffer; filename: string; mimeType: string }> {
    return this.call(
      'GET',
      `/internal/requests/${encodeURIComponent(id)}/messages/${encodeURIComponent(messageId)}/file`,
      undefined,
      async (res) => ({
        data: Buffer.from(await res.arrayBuffer()),
        filename: filenameOf(res.headers.get('content-disposition')),
        mimeType: res.headers.get('content-type') ?? 'application/octet-stream',
      }),
    );
  }

  private post(id: string, action: string, body: object): Promise<{ request: FinanceRequestView }> {
    return this.call(
      'POST',
      `/internal/requests/${encodeURIComponent(id)}/${action}`,
      body,
      (res) => res.json() as Promise<{ request: FinanceRequestView }>,
    );
  }

  private async call<T>(
    method: 'GET' | 'POST',
    path: string,
    body: object | undefined,
    parse: (res: Response) => Promise<T>,
  ): Promise<T> {
    const baseUrl = optionalNonBlank(this.config, 'FINANCE_API_URL');
    const token = optionalNonBlank(this.config, 'FINANCE_API_TOKEN');
    if (!baseUrl || !token) throw new FinanceApiError(0, 'disabled');

    let res: Response;
    try {
      res = await fetch(`${baseUrl.replace(/\/+$/, '')}${path}`, {
        method,
        headers: {
          'x-api-token': token,
          ...(body && { 'content-type': 'application/json' }),
        },
        ...(body && { body: JSON.stringify(body) }),
        redirect: 'error',
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (res.ok) return await parse(res);
    } catch (error) {
      const timedOut = (error as { name?: string } | null)?.name === 'TimeoutError';
      throw new FinanceApiError(0, timedOut ? 'timeout' : 'network');
    }

    const parsed: unknown = await res.json().catch(() => null);
    const { error, ...details } =
      parsed !== null && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
    throw new FinanceApiError(
      res.status,
      typeof error === 'string' ? error : `http-${res.status}`,
      Object.keys(details).length > 0 ? details : undefined,
    );
  }
}
