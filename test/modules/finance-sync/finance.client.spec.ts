import { ConfigService } from '@nestjs/config';
import { FinanceApiError } from '../../../src/modules/finance-sync/finance.types';
import { FinanceClient } from '../../../src/modules/finance-sync/finance.client';

const config = (values: Record<string, string>) => ({ get: (key: string) => values[key] });

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const createBody = {
  requesterTelegramId: 1,
  requesterName: 'Ann',
  kind: 'card' as const,
  orders: [{ orderNumber: '1-1', amount: 10 }],
  officialDocs: false,
  groupChatId: -100,
  groupMessageId: 5,
};

const failure = (promise: Promise<unknown>): Promise<unknown> =>
  promise.then(
    () => undefined,
    (e: unknown) => e,
  );

describe('FinanceClient', () => {
  let fetchMock: jest.Mock<Promise<Response>, [string, RequestInit]>;
  let client: FinanceClient;
  const firstCall = (): [string, RequestInit] => fetchMock.mock.calls[0] ?? ['', {}];

  beforeEach(() => {
    fetchMock = jest.fn<Promise<Response>, [string, RequestInit]>();
    global.fetch = fetchMock as unknown as typeof fetch;
    client = new FinanceClient(
      config({
        FINANCE_API_URL: 'http://finance.local/api/v1/',
        FINANCE_API_TOKEN: 'secret-token',
      }) as unknown as ConfigService,
    );
  });

  it('should join the url without a double slash and send the token header, timeout signal and redirect error', async () => {
    fetchMock.mockResolvedValue(json(200, { request: { id: 'r1' } }));

    await client.get('r1');

    const [url, init] = firstCall();
    expect(url).toBe('http://finance.local/api/v1/internal/requests/r1');
    expect(init.method).toBe('GET');
    expect(init.redirect).toBe('error');
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect((init.headers as Record<string, string>)['x-api-token']).toBe('secret-token');
  });

  it('should send a JSON body with content-type on POST', async () => {
    fetchMock.mockResolvedValue(json(200, { request: { id: 'r1' } }));

    await client.cancel('r1', { actorTelegramId: 2, actorName: 'Bob' });

    const [url, init] = firstCall();
    expect(url).toBe('http://finance.local/api/v1/internal/requests/r1/cancel');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)['content-type']).toBe('application/json');
    expect(JSON.parse(init.body as string)).toEqual({ actorTelegramId: 2, actorName: 'Bob' });
  });

  it('should unwrap the request on accept and cancel', async () => {
    fetchMock.mockResolvedValue(json(200, { request: { id: 'r1', status: 'accepted' } }));

    await expect(client.accept('r1', { responderTelegramId: 3, fopId: 7 })).resolves.toEqual({
      id: 'r1',
      status: 'accepted',
    });
  });

  it('should post the edit body and unwrap the request', async () => {
    fetchMock.mockResolvedValue(json(200, { request: { id: 'r1', comment: 'x' } }));

    await expect(
      client.edit('r1', { requesterTelegramId: 2, comment: 'x', officialDocs: false }),
    ).resolves.toEqual({ id: 'r1', comment: 'x' });

    const [url, init] = firstCall();
    expect(url).toBe('http://finance.local/api/v1/internal/requests/r1/edit');
    expect(JSON.parse(init.body as string)).toEqual({
      requesterTelegramId: 2,
      comment: 'x',
      officialDocs: false,
    });
  });

  it('should pass requesterTelegramId as a query parameter for fops', async () => {
    const fops = { limitsEnabled: true, limitsStatus: 'ok', project: null, fops: [] };
    fetchMock.mockResolvedValue(json(200, fops));

    await expect(client.fops(42)).resolves.toEqual(fops);

    expect(firstCall()[0]).toBe('http://finance.local/api/v1/internal/fops?requesterTelegramId=42');
  });

  it('should encode the request id in the path', async () => {
    fetchMock.mockResolvedValue(json(200, { request: {} }));

    await client.get('a/b');

    expect(firstCall()[0]).toBe('http://finance.local/api/v1/internal/requests/a%2Fb');
  });

  it('should post a message and resolve to nothing', async () => {
    fetchMock.mockResolvedValue(json(201, { message: { id: 'm1' } }));

    await expect(
      client.postMessage('r1', {
        authorTelegramId: 1,
        authorName: 'Ann',
        body: 'hi',
        clientId: 'c-1',
      }),
    ).resolves.toBeUndefined();
  });

  it('should turn a 422 error body into FinanceApiError', async () => {
    fetchMock.mockResolvedValue(json(422, { error: 'fop-limit-exceeded' }));

    const error = await failure(client.accept('r1', { responderTelegramId: 3, fopId: 7 }));

    expect(error).toBeInstanceOf(FinanceApiError);
    expect(error).toMatchObject({ status: 422, code: 'fop-limit-exceeded', details: undefined });
  });

  it('should keep the project of fop-foreign-project in details', async () => {
    fetchMock.mockResolvedValue(json(422, { error: 'fop-foreign-project', project: 'P1' }));

    const error = await failure(client.accept('r1', { responderTelegramId: 3, fopId: 7 }));

    expect(error).toMatchObject({
      status: 422,
      code: 'fop-foreign-project',
      details: { project: 'P1' },
    });
  });

  it('should keep orderNumber of order-taken in details', async () => {
    fetchMock.mockResolvedValue(json(409, { error: 'order-taken', orderNumber: '1-1' }));

    const error = await failure(client.create(createBody));

    expect(error).toMatchObject({
      status: 409,
      code: 'order-taken',
      details: { orderNumber: '1-1' },
    });
  });

  it('should keep validation details', async () => {
    const details = [{ field: 'sum', message: 'bad' }];
    fetchMock.mockResolvedValue(json(400, { error: 'Bad Request', details }));

    const error = await failure(client.create(createBody));

    expect(error).toMatchObject({ status: 400, code: 'Bad Request', details: { details } });
  });

  it('should use a fallback code when the error body is not JSON', async () => {
    fetchMock.mockResolvedValue(new Response('<html>', { status: 502 }));

    const error = await failure(client.get('r1'));

    expect(error).toMatchObject({ status: 502, code: 'http-502' });
  });

  it('should map a fetch failure to code network', async () => {
    fetchMock.mockRejectedValue(new TypeError('fetch failed'));

    await expect(client.get('r1')).rejects.toMatchObject({ status: 0, code: 'network' });
  });

  it('should map a timeout to code timeout', async () => {
    fetchMock.mockRejectedValue(new DOMException('timed out', 'TimeoutError'));

    await expect(client.get('r1')).rejects.toMatchObject({ status: 0, code: 'timeout' });
  });

  it('should retry create once after a network error and return the second answer', async () => {
    fetchMock
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(json(201, { id: 'r1', number: '77' }));

    await expect(client.create(createBody)).resolves.toEqual({ id: 'r1', number: '77' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('should retry create once after a timeout and then give up', async () => {
    fetchMock.mockRejectedValue(new DOMException('timed out', 'TimeoutError'));

    await expect(client.create(createBody)).rejects.toMatchObject({ code: 'timeout' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('should not retry create on an HTTP error', async () => {
    fetchMock.mockResolvedValue(json(409, { error: 'group-message-taken' }));

    await expect(client.create(createBody)).rejects.toMatchObject({ code: 'group-message-taken' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('should not retry accept after a network error', async () => {
    fetchMock.mockRejectedValue(new TypeError('fetch failed'));

    await expect(client.accept('r1', { responderTelegramId: 3, fopId: 7 })).rejects.toMatchObject({
      code: 'network',
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('should not retry cancel, get, fops or postMessage after a network error', async () => {
    fetchMock.mockRejectedValue(new TypeError('fetch failed'));

    await client.cancel('r1', { actorTelegramId: 1, actorName: 'A' }).catch(() => undefined);
    await client.get('r1').catch(() => undefined);
    await client.fops(1).catch(() => undefined);
    await client
      .postMessage('r1', { authorTelegramId: 1, authorName: 'A', body: 'b', clientId: 'c' })
      .catch(() => undefined);

    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  describe('file', () => {
    it('should return the bytes and the decoded filename from Content-Disposition', async () => {
      fetchMock.mockResolvedValue(
        new Response(Buffer.from([1, 2, 3]), {
          status: 200,
          headers: {
            'content-type': 'application/pdf',
            'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent('рахунок 1.pdf')}`,
          },
        }),
      );

      const file = await client.file('r1', 'm1');

      expect(firstCall()[0]).toBe(
        'http://finance.local/api/v1/internal/requests/r1/messages/m1/file',
      );
      expect(file.filename).toBe('рахунок 1.pdf');
      expect(file.mimeType).toBe('application/pdf');
      expect(Buffer.isBuffer(file.data)).toBe(true);
      expect([...file.data]).toEqual([1, 2, 3]);
    });

    it('should fall back to a plain filename= and to defaults', async () => {
      fetchMock.mockResolvedValueOnce(
        new Response('x', { headers: { 'content-disposition': 'attachment; filename="a.txt"' } }),
      );
      fetchMock.mockResolvedValueOnce(new Response(Buffer.from('x')));

      expect((await client.file('r1', 'm1')).filename).toBe('a.txt');
      const bare = await client.file('r1', 'm1');
      expect(bare.filename).toBe('file');
      expect(bare.mimeType).toBe('application/octet-stream');
    });

    it('should throw FinanceApiError on 404', async () => {
      fetchMock.mockResolvedValue(json(404, { error: 'not-found' }));

      await expect(client.file('r1', 'm1')).rejects.toMatchObject({
        status: 404,
        code: 'not-found',
      });
    });
  });

  it.each([
    ['FINANCE_API_URL', { FINANCE_API_TOKEN: 'secret-token' }],
    ['FINANCE_API_TOKEN', { FINANCE_API_URL: 'http://finance.local' }],
    ['both', {}],
  ])(
    'should fail with a FinanceApiError «disabled» without calling out when %s is unset',
    async (_, values) => {
      client = new FinanceClient(config(values) as unknown as ConfigService);

      const error = await failure(client.get('r1'));

      expect(error).toBeInstanceOf(FinanceApiError);
      expect(error).toMatchObject({ status: 0, code: 'disabled' });
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );
});
