import { HttpStatus, Logger } from '@nestjs/common';
import { ApiError } from '../../../src/common/api-error';
import type { FinanceRequestCard, Manager } from '../../../src/generated/prisma/client';
import type { FinanceClient } from '../../../src/modules/finance-sync/finance.client';
import { FinanceApiError } from '../../../src/modules/finance-sync/finance.types';
import type { FinanceRequestView } from '../../../src/modules/finance-sync/finance.types';
import type { RequestCardsRepository } from '../../../src/modules/finance-sync/request-cards.repository';
import type { RequestCreateService } from '../../../src/modules/finance-sync/request-create.service';
import type { RequestCompletionService } from '../../../src/modules/miniapp/request-completion.service';
import type { RequestSyncService } from '../../../src/modules/finance-sync/request-sync.service';
import { MiniappController } from '../../../src/modules/miniapp/miniapp.controller';
import type {
  CreateMiniappRequestDto,
  EditMiniappRequestDto,
} from '../../../src/modules/miniapp/miniapp.dto';

const manager = { id: 4, telegramId: 555n, name: 'Уляна' } as Manager;
const card = { requestId: 'req1', managerId: 4 } as FinanceRequestCard;
const view = { id: 'req1', number: '42', status: 'pending', kind: 'minus' } as FinanceRequestView;

const failure = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ApiError) {
      const body = error.getResponse() as { code: string; message: string; statusCode: number };
      return { status: error.getStatus(), ...body };
    }
    throw error;
  }
  throw new Error('Expected a rejection');
};

describe('MiniappController', () => {
  const requests = { create: jest.fn() };
  const finance = { get: jest.fn(), edit: jest.fn() };
  const cards = { byRequestId: jest.fn() };
  const sync = { renderManager: jest.fn(), renderGroup: jest.fn() };
  const completion = { complete: jest.fn() };
  const controller = new MiniappController(
    requests as unknown as RequestCreateService,
    finance as unknown as FinanceClient,
    cards as unknown as RequestCardsRepository,
    sync as unknown as RequestSyncService,
    completion as unknown as RequestCompletionService,
  );

  beforeEach(() => {
    requests.create.mockResolvedValue({ ok: true, requestId: 'req1', number: '42', note: null });
    cards.byRequestId.mockResolvedValue(card);
    finance.get.mockResolvedValue({ request: view });
    finance.edit.mockResolvedValue(view);
  });

  afterEach(() => jest.resetAllMocks());

  describe('create', () => {
    const order = { orderNumber: '0000-070217', amount: '4972' };
    const base = { officialDocs: true };
    const create = (dto: Partial<CreateMiniappRequestDto>) =>
      controller.create(manager, { ...base, ...dto } as CreateMiniappRequestDto);

    it('should pass an our_fop request with a normalised number to the service', async () => {
      const answer = await create({
        kind: 'our_fop',
        orders: [{ ...order, orderNumber: ' 0000-070217 ' }],
        exchangeRate: '45.7',
        comment: ' Терміново ',
      });

      expect(answer).toEqual({ requestId: 'req1', number: '42' });
      expect(requests.create).toHaveBeenCalledWith(manager, {
        kind: 'our_fop',
        orders: [{ orderNumber: '0000-070217', amount: '4972', exchangeRate: null }],
        exchangeRate: '45.7',
        comment: 'Терміново',
        officialDocs: true,
      });
    });

    it('should keep two foreign_fop orders with a rate per row', async () => {
      await create({
        kind: 'foreign_fop',
        orders: [
          { ...order, exchangeRate: '44.5' },
          { orderNumber: '0000-072611', amount: '11124.50' },
        ],
      });

      expect(requests.create).toHaveBeenCalledWith(
        manager,
        expect.objectContaining({
          kind: 'foreign_fop',
          orders: [
            { orderNumber: '0000-070217', amount: '4972', exchangeRate: '44.5' },
            { orderNumber: '0000-072611', amount: '11124.50', exchangeRate: null },
          ],
        }),
      );
    });

    it('should pass a card request', async () => {
      await create({ kind: 'card', orders: [order] });

      expect(requests.create).toHaveBeenCalledWith(
        manager,
        expect.objectContaining({ kind: 'card' }),
      );
    });

    it('should pass a minus request with sum, client, sheet and percent', async () => {
      await create({
        kind: 'minus',
        sum: '1500.50',
        clientLabel: ' Іван ',
        sheetUrl: 'https://s/1',
        withPercent: true,
      });

      expect(requests.create).toHaveBeenCalledWith(manager, {
        kind: 'minus',
        sum: '1500.50',
        clientLabel: 'Іван',
        sheetUrl: 'https://s/1',
        withPercent: true,
        exchangeRate: null,
        comment: null,
        officialDocs: true,
      });
    });

    it('should treat null optional fields as absent on create', async () => {
      await create({
        kind: 'card',
        orders: [{ ...order, exchangeRate: null }],
        exchangeRate: null,
        comment: null,
      } as unknown as Partial<CreateMiniappRequestDto>);

      expect(requests.create).toHaveBeenCalledWith(
        manager,
        expect.objectContaining({ exchangeRate: null, comment: null }),
      );
    });

    it('should drop withPercent for dropship', async () => {
      await create({ kind: 'dropship', sum: '700', clientLabel: 'Петро', withPercent: true });

      expect(requests.create).toHaveBeenCalledWith(
        manager,
        expect.objectContaining({ kind: 'dropship', withPercent: null }),
      );
    });

    it.each([
      ['minus without clientLabel', { kind: 'minus', sum: '100' }],
      ['minus with a blank clientLabel', { kind: 'minus', sum: '100', clientLabel: '  ' }],
      ['dropship without sum', { kind: 'dropship', clientLabel: 'A' }],
      ['minus with a bad sum', { kind: 'minus', sum: '10,5', clientLabel: 'A' }],
      ['our_fop without orders', { kind: 'our_fop' }],
      ['our_fop with 21 orders', { kind: 'our_fop', orders: Array(21).fill(order) }],
      ['a bad order number', { kind: 'card', orders: [{ ...order, orderNumber: '070217' }] }],
      ['a bad amount', { kind: 'card', orders: [{ ...order, amount: '0' }] }],
      ['a bad row rate', { kind: 'card', orders: [{ ...order, exchangeRate: 'abc' }] }],
      ['a rate above 1000', { kind: 'card', orders: [order], exchangeRate: '1001' }],
      ['duplicate numbers', { kind: 'our_fop', orders: [order, { ...order, amount: '5' }] }],
    ] as [string, Partial<CreateMiniappRequestDto>][])(
      'should answer 400 and not create for %s',
      async (_, dto) => {
        const error = await failure(create(dto));

        expect(error).toMatchObject({ status: 400, statusCode: 400, code: 'invalid-request' });
        expect(error.message).toEqual(expect.any(String));
        expect(requests.create).not.toHaveBeenCalled();
      },
    );

    it('should name the repeated number', async () => {
      const error = await failure(create({ kind: 'card', orders: [order, order] }));

      expect(error.message).toContain('0000-070217');
    });

    it('should expose a note about a created request that is not fully shown', async () => {
      requests.create.mockResolvedValue({ ok: true, requestId: 'req1', number: '42', note: 'n' });

      await expect(create({ kind: 'card', orders: [order] })).resolves.toEqual({
        requestId: 'req1',
        number: '42',
        message: 'n',
      });
    });

    it.each([
      ['not-created', 'order-taken', HttpStatus.CONFLICT],
      ['not-created', 'http-400', HttpStatus.UNPROCESSABLE_ENTITY],
      ['unknown', 'finance-no-answer', HttpStatus.BAD_GATEWAY],
      ['disabled', 'finance-disabled', HttpStatus.SERVICE_UNAVAILABLE],
    ])(
      'should map a %s result with code %s to %s, keeping the message',
      async (outcome, code, status) => {
        requests.create.mockResolvedValue({ ok: false, outcome, code, message: 'текст' });

        const error = await failure(create({ kind: 'card', orders: [order] }));

        expect(error).toMatchObject({ status, code, message: 'текст' });
      },
    );
  });

  describe('get', () => {
    it('should return the view, the manager name and completed', async () => {
      await expect(controller.get(manager, 'req1')).resolves.toEqual({
        request: view,
        managerName: 'Уляна',
        completed: false,
      });
      expect(finance.get).toHaveBeenCalledWith('req1');
    });

    it.each([
      ['unknown', null],
      ['another manager’s', { ...card, managerId: 9 }],
    ])('should answer 404, without asking finance, for %s request', async (_, found) => {
      cards.byRequestId.mockResolvedValue(found);

      const error = await failure(controller.get(manager, 'req1'));

      expect(error).toMatchObject({ status: 404, code: 'not-found' });
      expect(finance.get).not.toHaveBeenCalled();
    });

    it.each([
      ['no answer', new FinanceApiError(0, 'timeout')],
      ['a 502', new FinanceApiError(502, 'http-502')],
    ])('should answer 502 on %s from finance', async (_, error) => {
      finance.get.mockRejectedValue(error);

      await expect(failure(controller.get(manager, 'req1'))).resolves.toMatchObject({
        status: 502,
        code: 'finance-no-answer',
      });
    });

    it.each([
      [403, 'not-allowed'],
      [422, 'unprocessable'],
    ])('should answer 422 finance-refused on a definite %s from finance', async (status, code) => {
      finance.get.mockRejectedValue(new FinanceApiError(status, code));

      await expect(failure(controller.get(manager, 'req1'))).resolves.toMatchObject({
        status: 422,
        code: 'finance-refused',
        message: `Фінанси відхилили запит (${code}).`,
      });
    });
  });

  describe('complete', () => {
    it('should pass the manager, the id and the body to the completion service', async () => {
      const dto = { payments: [{ amount: '10', date: '2026-11-04' }] };
      completion.complete.mockResolvedValue({ orderNumbers: ['1'], skipped: [] });

      await expect(controller.complete(manager, 'req1', dto)).resolves.toEqual({
        orderNumbers: ['1'],
        skipped: [],
      });
      expect(completion.complete).toHaveBeenCalledWith(manager, 'req1', dto);
    });
  });

  describe('completed flag', () => {
    it('should report completed once the card has a completedAt', async () => {
      cards.byRequestId.mockResolvedValue({ ...card, completedAt: new Date() });

      await expect(controller.get(manager, 'req1')).resolves.toMatchObject({ completed: true });
    });
  });

  describe('edit', () => {
    const edit = (dto: Partial<EditMiniappRequestDto>) => controller.edit(manager, 'req1', dto);

    it('should send the changes, redraw both cards and return the view', async () => {
      const answer = await edit({ exchangeRate: '45.7', comment: ' ', officialDocs: false });

      expect(finance.edit).toHaveBeenCalledWith('req1', {
        requesterTelegramId: 555,
        exchangeRate: 45.7,
        comment: null,
        officialDocs: false,
      });
      expect(sync.renderManager).toHaveBeenCalledWith(card, view);
      expect(sync.renderGroup).toHaveBeenCalledWith(card, view);
      expect(answer).toEqual({ request: view, managerName: 'Уляна', completed: false });
    });

    it('should send a sum as a number', async () => {
      await edit({ sum: '1500.50' });

      expect(finance.edit).toHaveBeenCalledWith('req1', { requesterTelegramId: 555, sum: 1500.5 });
    });

    it.each([
      ['exchangeRate', { exchangeRate: null }],
      ['sum', { sum: null }],
      ['comment', { comment: null }],
      ['officialDocs', { officialDocs: null }],
    ])('should treat a null %s as absent, not fail', async (_, dto) => {
      await edit(dto as unknown as Partial<EditMiniappRequestDto>);

      expect(finance.edit).toHaveBeenCalledWith('req1', { requesterTelegramId: 555 });
    });

    it('should answer 422 finance-refused when finance refuses an edit definitely', async () => {
      finance.edit.mockRejectedValue(new FinanceApiError(403, 'not-owner'));

      const error = await failure(edit({ comment: 'x' }));

      expect(error).toMatchObject({ status: 422, code: 'finance-refused' });
    });

    it('should answer 409 already-closed when finance refuses an accepted request', async () => {
      finance.edit.mockRejectedValue(new FinanceApiError(409, 'already-closed'));

      const error = await failure(edit({ comment: 'x' }));

      expect(error).toMatchObject({ status: 409, code: 'already-closed' });
      expect(sync.renderManager).not.toHaveBeenCalled();
    });

    it('should answer 400 sum-locked when the sum is edited on our_fop', async () => {
      finance.edit.mockRejectedValue(new FinanceApiError(400, 'sum-locked'));

      const error = await failure(edit({ sum: '10' }));

      expect(error).toMatchObject({ status: 400, code: 'sum-locked' });
    });

    it.each([
      ['a bad sum', { sum: '1,5' }],
      ['a bad rate', { exchangeRate: '0' }],
    ])('should answer 400, without calling finance, for %s', async (_, dto) => {
      const error = await failure(edit(dto));

      expect(error).toMatchObject({ status: 400, code: 'invalid-request' });
      expect(finance.edit).not.toHaveBeenCalled();
    });

    it('should answer 404 for another manager’s request', async () => {
      cards.byRequestId.mockResolvedValue({ ...card, managerId: 9 });

      const error = await failure(edit({ comment: 'x' }));

      expect(error).toMatchObject({ status: 404, code: 'not-found' });
      expect(finance.edit).not.toHaveBeenCalled();
    });

    it('should say the edit is unconfirmed when finance does not answer', async () => {
      finance.edit.mockRejectedValue(new FinanceApiError(0, 'network'));

      const error = await failure(edit({ comment: 'x' }));

      expect(error).toMatchObject({ status: 502, code: 'finance-no-answer' });
    });

    it('should answer 503 finance-disabled when the finance API is not configured', async () => {
      finance.edit.mockRejectedValue(new FinanceApiError(0, 'disabled'));

      const error = await failure(edit({ comment: 'x' }));

      expect(error).toMatchObject({ status: 503, code: 'finance-disabled' });
    });

    it('should still confirm the edit when a card redraw fails', async () => {
      sync.renderManager.mockRejectedValue(new Error('telegram down'));
      jest.spyOn(Logger.prototype, 'error').mockImplementation();

      await expect(edit({ comment: 'x' })).resolves.toMatchObject({ request: view });
    });
  });
});
