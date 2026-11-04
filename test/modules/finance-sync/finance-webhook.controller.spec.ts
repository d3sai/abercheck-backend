import { INestApplication, VersioningType } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { FinanceWebhookController } from '../../../src/modules/finance-sync/finance-webhook.controller';
import { FinanceApiError } from '../../../src/modules/finance-sync/finance.types';
import { RequestSyncService } from '../../../src/modules/finance-sync/request-sync.service';

const TOKEN = 't'.repeat(32);
const event = { type: 'accepted', requestId: 'req1', request: { id: 'req1' } };

describe('POST /api/finance/webhook', () => {
  const sync = { handle: jest.fn() };
  const settings: Record<string, string | undefined> = {};
  let app: INestApplication;
  let url: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [FinanceWebhookController],
      providers: [
        { provide: RequestSyncService, useValue: sync },
        { provide: ConfigService, useValue: { get: (key: string) => settings[key] } },
      ],
    }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    // as in main.ts: the route must still be /api/finance/webhook with URI versioning on
    app.setGlobalPrefix('api');
    app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
    await app.listen(0);
    url = `http://127.0.0.1:${((app.getHttpServer() as Server).address() as AddressInfo).port}/api/finance/webhook`;
  });
  afterAll(() => app.close());

  beforeEach(() => {
    settings.FINANCE_API_URL = 'https://finance.example';
    settings.FINANCE_WEBHOOK_TOKEN = TOKEN;
    sync.handle.mockResolvedValue(undefined);
  });
  afterEach(() => jest.resetAllMocks());

  const post = (token?: string, body: unknown = event) =>
    fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(token && { 'x-api-token': token }) },
      body: JSON.stringify(body),
    });

  it('should hand the event to the sync service and answer 200 { ok: true }', async () => {
    const res = await post(TOKEN);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(sync.handle).toHaveBeenCalledWith(event);
  });

  it.each([undefined, '', 'wrong', `${TOKEN}x`])(
    'should answer 401 for the token %p',
    async (token) => {
      const res = await post(token);

      expect(res.status).toBe(401);
      expect(sync.handle).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['FINANCE_API_URL', ''],
    ['FINANCE_API_URL', undefined],
    ['FINANCE_WEBHOOK_TOKEN', ''],
  ])('should answer 404 when finance is disabled (%s=%p)', async (key, value) => {
    settings[key] = value;

    const res = await post(TOKEN);

    expect(res.status).toBe(404);
    expect(sync.handle).not.toHaveBeenCalled();
  });

  it('should answer 500 when the sync fails, so finance retries', async () => {
    sync.handle.mockRejectedValue(new FinanceApiError(0, 'network'));

    const res = await post(TOKEN);

    expect(res.status).toBe(500);
  });

  it('should answer 400 for a body without a request id', async () => {
    const res = await post(TOKEN, { type: 'accepted' });

    expect(res.status).toBe(400);
    expect(sync.handle).not.toHaveBeenCalled();
  });
});
