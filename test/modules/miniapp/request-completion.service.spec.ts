import { HttpStatus, Logger } from '@nestjs/common';
import { ApiError } from '../../../src/common/api-error';
import { kyivDateTime } from '../../../src/common/kyiv-time';
import {
  Currency,
  type FinanceRequestCard,
  type Manager,
  OrderType,
  Prisma,
} from '../../../src/generated/prisma/client';
import type { FinanceClient } from '../../../src/modules/finance-sync/finance.client';
import {
  FinanceApiError,
  type FinanceRequestView,
  type RequestKind,
} from '../../../src/modules/finance-sync/finance.types';
import type { RequestReceiptsService } from '../../../src/modules/finance-sync/request-receipts.service';
import type { RequestCardsRepository } from '../../../src/modules/finance-sync/request-cards.repository';
import type { CompleteMiniappRequestDto } from '../../../src/modules/miniapp/miniapp.dto';
import { RequestCompletionService } from '../../../src/modules/miniapp/request-completion.service';
import { OrderNumberTakenError } from '../../../src/modules/orders/orders.errors';
import type { OrdersService } from '../../../src/modules/orders/orders.service';
import type { RequisitesService } from '../../../src/modules/requisites/requisites.service';
import type { TelegramSender } from '../../../src/modules/telegram/core/telegram-sender';

const manager = { id: 4, telegramId: 555n, name: 'Уляна' } as Manager;
const card = {
  requestId: 'req1',
  managerId: 4,
  managerChatId: 555n,
  managerMessageId: 77,
  completedAt: null,
} as FinanceRequestCard;

const orderRow = (orderNumber: string, amount: string, exchangeRate: string | null = null) => ({
  orderNumber,
  amount,
  exchangeRate,
});

function accepted(kind: RequestKind, patch: Partial<FinanceRequestView> = {}): FinanceRequestView {
  return {
    id: 'req1',
    number: '42',
    status: 'accepted',
    kind,
    sum: '1000.00',
    orderNumber: null,
    orders: [],
    exchangeRate: '44.9',
    comment: 'терміново',
    officialDocs: true,
    clientLabel: null,
    sheetUrl: null,
    withPercent: null,
    isPaid: false,
    requestDate: '2026-11-04',
    responseDate: null,
    cancelledAt: null,
    fopLabel: 'ФОП Іванов',
    responderName: 'Фін',
    payouts: [],
    warnings: [],
    managerChatId: 555,
    groupChatId: -100,
    groupMessageId: 9,
    ...patch,
  };
}

const order = (id: number, orderNumber: string, patch: Record<string, unknown> = {}) => ({
  id,
  orderNumber,
  baseNumber: orderNumber.split('-').slice(0, 2).join('-'),
  clientName: 'ФОП Іванов',
  amountDue: new Prisma.Decimal('1000'),
  currency: Currency.UAH,
  exchangeRate: null,
  comment: null,
  createdAt: new Date('2026-11-04T10:00:00Z'),
  ...patch,
});

/** The `index`-th argument of the first call of a mock. */
const callArg = (fn: jest.Mock, index: number): unknown => (fn.mock.calls[0] as unknown[])[index];

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

const body = (payments: CompleteMiniappRequestDto['payments']): CompleteMiniappRequestDto => ({
  payments,
});

describe('RequestCompletionService', () => {
  const finance = { get: jest.fn() };
  const cards = {
    byRequestId: jest.fn(),
    claimCompletion: jest.fn(),
    releaseCompletion: jest.fn(),
    setOrderIds: jest.fn(),
  };
  const orders = { findWithBalance: jest.fn(), create: jest.fn(), createGroup: jest.fn() };
  const requisites = { addMany: jest.fn() };
  const sender = {
    miniAppUrl: undefined as string | undefined,
    sendToAdmins: jest.fn(),
    editMessage: jest.fn(),
  };
  const receipts = { attachHeld: jest.fn() };
  const service = new RequestCompletionService(
    finance as unknown as FinanceClient,
    cards as unknown as RequestCardsRepository,
    orders as unknown as OrdersService,
    requisites as unknown as RequisitesService,
    sender as unknown as TelegramSender,
    receipts as unknown as RequestReceiptsService,
  );

  let logError: jest.SpyInstance;

  const view = (kind: RequestKind, patch: Partial<FinanceRequestView> = {}) =>
    finance.get.mockResolvedValue({ request: accepted(kind, patch) });

  beforeEach(() => {
    logError = jest.spyOn(Logger.prototype, 'error').mockImplementation();
    cards.byRequestId.mockResolvedValue(card);
    cards.claimCompletion.mockResolvedValue(true);
    cards.releaseCompletion.mockResolvedValue(undefined);
    cards.setOrderIds.mockResolvedValue(undefined);
    orders.findWithBalance.mockResolvedValue(null);
    requisites.addMany.mockResolvedValue([]);
    sender.miniAppUrl = undefined;
    sender.sendToAdmins.mockResolvedValue(1);
    sender.editMessage.mockResolvedValue(true);
    receipts.attachHeld.mockResolvedValue(undefined);
  });

  afterEach(() => {
    jest.resetAllMocks();
    jest.restoreAllMocks();
  });

  describe('our_fop', () => {
    const one = { orders: [orderRow('0000-070217', '1000')] };

    it('should create one REGULAR order with the FOP label and the first payment date', async () => {
      view('our_fop', one);
      orders.create.mockResolvedValue(order(10, '0000-070217'));

      const result = await service.complete(
        manager,
        'req1',
        body([{ amount: '1000', date: '2026-11-04' }]),
      );

      expect(orders.create).toHaveBeenCalledWith(
        4,
        {
          orderType: OrderType.REGULAR,
          orderNumber: '0000-070217',
          clientName: 'ФОП Іванов',
          amountDue: '1000.00',
          currency: Currency.UAH,
          exchangeRate: '44.9',
          comment: 'терміново',
          paidAt: kyivDateTime(2026, 11, 4),
        },
        { notify: true, addPart: false },
      );
      expect(result).toEqual({ orderNumbers: ['0000-070217'], skipped: [] });
      expect(cards.claimCompletion).toHaveBeenCalledWith('req1', expect.any(Date));
      expect(cards.setOrderIds).toHaveBeenCalledWith('req1', [10]);
      expect(cards.releaseCompletion).not.toHaveBeenCalled();
    });

    it('should take the time of the payment when one is given', async () => {
      view('our_fop', one);
      orders.create.mockResolvedValue(order(10, '0000-070217'));

      await service.complete(
        manager,
        'req1',
        body([{ amount: '1000', date: '2026-07-04', time: '14:30' }]),
      );

      expect(callArg(orders.create, 1)).toMatchObject({ paidAt: kyivDateTime(2026, 7, 4, 14, 30) });
    });

    it('should create a group with per-row rates for several orders', async () => {
      view('our_fop', {
        orders: [orderRow('0000-070217', '600', '45'), orderRow('0000-070218', '400')],
      });
      orders.createGroup.mockResolvedValue([order(10, '0000-070217'), order(11, '0000-070218')]);

      const result = await service.complete(
        manager,
        'req1',
        body([{ amount: '1000', date: '2026-11-04' }]),
      );

      expect(orders.createGroup).toHaveBeenCalledWith(
        4,
        [
          { orderNumber: '0000-070217', amountDue: '600.00', exchangeRate: '45' },
          { orderNumber: '0000-070218', amountDue: '400.00', exchangeRate: undefined },
        ],
        {
          clientName: 'ФОП Іванов',
          currency: Currency.UAH,
          exchangeRate: '44.9',
          comment: 'терміново',
          paidAt: kyivDateTime(2026, 11, 4),
        },
        { notify: true },
      );
      expect(result.orderNumbers).toEqual(['0000-070217', '0000-070218']);
      expect(cards.setOrderIds).toHaveBeenCalledWith('req1', [10, 11]);
    });

    it('should edit the manager card text with the order numbers and no buttons', async () => {
      view('our_fop', {
        orders: [orderRow('0000-070217', '600'), orderRow('0000-070218', '400')],
      });
      orders.createGroup.mockResolvedValue([order(10, '0000-070217'), order(11, '0000-070218')]);

      await service.complete(manager, 'req1', body([{ amount: '1000', date: '2026-11-04' }]));

      expect(sender.editMessage).toHaveBeenCalledTimes(1);
      const [chat, message, html, buttons] = sender.editMessage.mock.calls[0] as unknown[];
      expect([chat, message, buttons]).toEqual([555n, 77, undefined]);
      expect(html).toContain('✅ Оформлено: № 0000-070217, 0000-070218 (2 замовлення)');
    });

    it('should draw the completed card with no Mini App button even when the URL is set', async () => {
      sender.miniAppUrl = 'https://cab.example.ua/tg/request';
      view('our_fop', one);
      orders.create.mockResolvedValue(order(10, '0000-070217'));

      await service.complete(manager, 'req1', body([{ amount: '1000', date: '2026-11-04' }]));

      const [, , html, buttons] = sender.editMessage.mock.calls[0] as unknown[];
      expect(html).toContain('✅ Оформлено: № 0000-070217');
      expect(buttons).toBeUndefined();
    });

    it('should still answer with the orders when the card cannot be redrawn', async () => {
      view('our_fop', one);
      orders.create.mockResolvedValue(order(10, '0000-070217'));
      sender.editMessage.mockRejectedValue(new Error('telegram down'));

      await expect(
        service.complete(manager, 'req1', body([{ amount: '1000', date: '2026-11-04' }])),
      ).resolves.toEqual({ orderNumbers: ['0000-070217'], skipped: [] });
      expect(cards.releaseCompletion).not.toHaveBeenCalled();
    });

    const existing = (patch: Record<string, unknown> = {}) =>
      orders.findWithBalance.mockResolvedValue({
        order: order(3, '0000-070217', { clientName: 'Чернявський', ...patch }),
        amountPaid: new Prisma.Decimal('250'),
      });

    it('should offer a part, create nothing and release the claim for an existing number', async () => {
      view('our_fop', one);
      existing();

      const error = await failure(
        service.complete(manager, 'req1', body([{ amount: '1000', date: '2026-11-04' }])),
      );

      expect(error).toMatchObject({
        status: HttpStatus.CONFLICT,
        code: 'order-exists-part',
        message: 'Номер 0000-070217 уже є в системі — додати як ще одну частину?',
        details: {
          orderNumber: '0000-070217',
          clientName: 'Чернявський',
          amountDue: '1000.00',
          paid: '250.00',
        },
      });
      expect(orders.create).not.toHaveBeenCalled();
      expect(cards.claimCompletion).not.toHaveBeenCalled();
    });

    it('should add a part to an existing number when the manager agreed', async () => {
      view('our_fop', one);
      existing();
      orders.create.mockResolvedValue(order(10, '0000-070217-2'));

      const result = await service.complete(manager, 'req1', {
        ...body([{ amount: '1000', date: '2026-11-04' }]),
        addPart: true,
      });

      expect(callArg(orders.create, 2)).toEqual({ notify: true, addPart: true });
      expect(result.orderNumbers).toEqual(['0000-070217-2']);
    });

    it('should answer order-taken, not offer a part, for an existing number in another currency', async () => {
      view('our_fop', one);
      existing({ currency: Currency.USD });

      const error = await failure(
        service.complete(manager, 'req1', {
          ...body([{ amount: '1000', date: '2026-11-04' }]),
          addPart: true,
        }),
      );

      expect(error).toMatchObject({ status: HttpStatus.CONFLICT, code: 'order-taken' });
      expect(cards.claimCompletion).not.toHaveBeenCalled();
    });

    it('should answer order-taken for a number inside another group', async () => {
      view('our_fop', one);
      existing({ orderNumber: '0000-070210' });

      const error = await failure(
        service.complete(manager, 'req1', body([{ amount: '1000', date: '2026-11-04' }])),
      );

      expect(error).toMatchObject({ code: 'order-taken' });
    });

    it.each<RequestKind>(['our_fop', 'foreign_fop', 'card'])(
      'should answer 422 request-has-no-orders for %s without orders and release the claim',
      async (kind) => {
        view(kind, { orders: [] });

        const error = await failure(
          service.complete(
            manager,
            'req1',
            body([{ payerName: 'Іван', amount: '1', date: '2026-11-04', time: '10:00' }]),
          ),
        );

        expect(error).toMatchObject({
          status: HttpStatus.UNPROCESSABLE_ENTITY,
          code: 'request-has-no-orders',
        });
        expect(cards.claimCompletion).not.toHaveBeenCalled();
      },
    );
  });

  describe('foreign_fop and card', () => {
    const two = [
      {
        payerName: 'Петренко Іван',
        account: '4441111069645962',
        amount: '700',
        date: '2026-11-04',
        time: '10:15',
      },
      { payerName: 'Петренко Ірина', amount: '300', date: '2026-11-04', time: '11:00' },
    ];

    it.each<RequestKind>(['card', 'foreign_fop'])(
      'should create the %s order and a requisite row per payment',
      async (kind) => {
        view(kind, { orders: [orderRow('0000-070217', '1000')] });
        orders.create.mockResolvedValue(order(10, '0000-070217'));
        requisites.addMany.mockResolvedValue([
          {
            payerName: 'Петренко Іван',
            account: '4441111069645962',
            amount: new Prisma.Decimal('700'),
            paidAt: kyivDateTime(2026, 11, 4, 10, 15),
          },
        ]);

        const result = await service.complete(manager, 'req1', body(two));

        expect(orders.create).toHaveBeenCalledWith(
          4,
          {
            orderType: OrderType.REGULAR,
            orderNumber: '0000-070217',
            clientName: 'Петренко Іван',
            currency: Currency.UAH,
            exchangeRate: '44.9',
            comment: 'терміново',
            amountDue: '1000.00',
          },
          { notify: false, addPart: false },
        );
        expect(requisites.addMany).toHaveBeenCalledWith(
          10,
          [
            {
              payerName: 'Петренко Іван',
              account: '4441111069645962',
              amount: '700.00',
              paidAt: kyivDateTime(2026, 11, 4, 10, 15),
            },
            {
              payerName: 'Петренко Ірина',
              account: null,
              amount: '300.00',
              paidAt: kyivDateTime(2026, 11, 4, 11, 0),
            },
          ],
          { telegramId: 555n, name: 'Уляна' },
        );
        expect(sender.sendToAdmins).toHaveBeenCalledWith(
          expect.stringContaining('Оплата на реквізити'),
        );
        expect(result).toEqual({ orderNumbers: ['0000-070217'], skipped: [] });
      },
    );

    it('should skip numbers that exist, report them and notify admins about them', async () => {
      view('card', {
        sum: '1000.00',
        orders: [orderRow('0000-070217', '600'), orderRow('0000-070218', '400')],
      });
      orders.findWithBalance.mockImplementation((number: string) =>
        Promise.resolve(number === '0000-070217' ? { order: order(3, '0000-070217') } : null),
      );
      orders.create.mockResolvedValue(order(11, '0000-070218'));

      const result = await service.complete(manager, 'req1', body(two));

      // one number left: a single order, as the bot's requisites flow re-plans it
      expect(orders.createGroup).not.toHaveBeenCalled();
      expect(callArg(orders.create, 1)).toMatchObject({
        orderNumber: '0000-070218',
        amountDue: '400.00',
      });
      expect(result).toEqual({ orderNumbers: ['0000-070218'], skipped: ['0000-070217'] });
      expect(sender.sendToAdmins).toHaveBeenCalledWith(
        expect.stringContaining('Не додано (уже є в системі): 0000-070217'),
      );
    });

    it('should refuse with 409 order-taken and release the claim when every number exists', async () => {
      view('card', { orders: [orderRow('0000-070217', '600'), orderRow('0000-070218', '400')] });
      orders.findWithBalance.mockResolvedValue({ order: order(3, '0000-070217') });

      const error = await failure(service.complete(manager, 'req1', body(two)));

      expect(error).toMatchObject({ status: HttpStatus.CONFLICT, code: 'order-taken' });
      expect(cards.claimCompletion).not.toHaveBeenCalled();
      expect(orders.createGroup).not.toHaveBeenCalled();
    });

    it('should answer 400 without a time and release the claim', async () => {
      view('card', { orders: [orderRow('0000-070217', '1000')] });

      const error = await failure(
        service.complete(
          manager,
          'req1',
          body([{ payerName: 'Петренко Іван', amount: '1000', date: '2026-11-04' }]),
        ),
      );

      expect(error).toMatchObject({ status: HttpStatus.BAD_REQUEST, code: 'invalid-request' });
      expect(cards.claimCompletion).not.toHaveBeenCalled();
      expect(orders.create).not.toHaveBeenCalled();
    });

    it('should answer 400 without a payer name', async () => {
      view('foreign_fop', { orders: [orderRow('0000-070217', '1000')] });

      const error = await failure(
        service.complete(
          manager,
          'req1',
          body([{ amount: '1000', date: '2026-11-04', time: '10:00' }]),
        ),
      );

      expect(error.status).toBe(HttpStatus.BAD_REQUEST);
    });
  });

  describe('minus and dropship', () => {
    const row = { amount: '1000', date: '2026-11-04', time: '09:05' };

    it('should create MINUS_CLOSING with the sheet link and the percent answer', async () => {
      view('minus', {
        clientLabel: 'Гук Руслан',
        sheetUrl: 'https://sheet.example/1',
        withPercent: true,
        comment: null,
      });
      orders.create.mockResolvedValue(
        order(10, 'MC-1', { orderType: OrderType.MINUS_CLOSING, clientName: 'Гук Руслан' }),
      );

      const result = await service.complete(manager, 'req1', body([row]));

      expect(orders.create).toHaveBeenCalledWith(
        4,
        {
          orderType: OrderType.MINUS_CLOSING,
          clientName: 'Гук Руслан',
          amountDue: '1000.00',
          currency: Currency.UAH,
          exchangeRate: '44.9',
          comment: 'з урахуванням %: так',
          paidAt: kyivDateTime(2026, 11, 4, 9, 5),
          ourFop: 'ФОП Іванов',
          period: undefined,
          sheetUrl: 'https://sheet.example/1',
        },
        { notify: false },
      );
      expect(sender.sendToAdmins).toHaveBeenCalledWith(expect.stringContaining('Гук Руслан'));
      expect(result).toEqual({ orderNumbers: ['MC-1'], skipped: [] });
    });

    it('should prefix a dropshipping client and keep the manager comment', async () => {
      view('dropship', { clientLabel: 'Іваненко', withPercent: false, comment: 'терміново' });
      orders.create.mockResolvedValue(order(10, 'MC-2'));

      await service.complete(manager, 'req1', body([row]));

      expect(callArg(orders.create, 1)).toMatchObject({
        orderType: OrderType.MINUS_CLOSING,
        clientName: 'Дропшипінг · Іваненко',
        comment: 'терміново · з урахуванням %: ні',
      });
    });

    it('should answer 400 without a time', async () => {
      view('minus', { clientLabel: 'Гук Руслан' });

      const error = await failure(
        service.complete(manager, 'req1', body([{ amount: '1000', date: '2026-11-04' }])),
      );

      expect(error.status).toBe(HttpStatus.BAD_REQUEST);
      expect(orders.create).not.toHaveBeenCalled();
    });

    it('should answer 400 for more than one payment row', async () => {
      view('dropship', { clientLabel: 'Іваненко' });

      const error = await failure(service.complete(manager, 'req1', body([row, row])));

      expect(error.status).toBe(HttpStatus.BAD_REQUEST);
      expect(cards.claimCompletion).not.toHaveBeenCalled();
    });
  });

  describe('payment rows', () => {
    it.each([
      ['a day the calendar does not have', { amount: '10', date: '2026-02-30' }],
      ['a malformed date', { amount: '10', date: '04.11.2026' }],
      ['a time out of range', { amount: '10', date: '2026-11-04', time: '25:00' }],
      ['a bad amount', { amount: '1,5', date: '2026-11-04' }],
    ])('should answer 400 for %s and release the claim', async (_, row) => {
      view('our_fop', { orders: [orderRow('0000-070217', '1000')] });

      const error = await failure(service.complete(manager, 'req1', body([row])));

      expect(error).toMatchObject({ status: HttpStatus.BAD_REQUEST, code: 'invalid-request' });
      expect(cards.claimCompletion).not.toHaveBeenCalled();
      expect(orders.create).not.toHaveBeenCalled();
    });
  });

  describe('the claim', () => {
    const row = { amount: '1000', date: '2026-11-04' };

    it('should answer 404 for a request of another manager without claiming it', async () => {
      cards.byRequestId.mockResolvedValue({ ...card, managerId: 9 });

      const error = await failure(service.complete(manager, 'req1', body([row])));

      expect(error).toMatchObject({ status: HttpStatus.NOT_FOUND, code: 'not-found' });
      expect(cards.claimCompletion).not.toHaveBeenCalled();
    });

    it('should answer 409 already-completed and create nothing when the claim is lost', async () => {
      view('our_fop', { orders: [orderRow('0000-070217', '1000')] });
      cards.claimCompletion.mockResolvedValue(false);

      const error = await failure(service.complete(manager, 'req1', body([row])));

      expect(error).toMatchObject({ status: HttpStatus.CONFLICT, code: 'already-completed' });
      expect(orders.create).not.toHaveBeenCalled();
      expect(orders.createGroup).not.toHaveBeenCalled();
      expect(cards.releaseCompletion).not.toHaveBeenCalled();
    });

    it('should answer 409 already-completed without asking finance for a completed card', async () => {
      cards.byRequestId.mockResolvedValue({ ...card, completedAt: new Date() });

      const error = await failure(service.complete(manager, 'req1', body([row])));

      expect(error).toMatchObject({ status: HttpStatus.CONFLICT, code: 'already-completed' });
      expect(finance.get).not.toHaveBeenCalled();
      expect(cards.claimCompletion).not.toHaveBeenCalled();
    });

    it('should not claim and answer 409 not-accepted for a pending request', async () => {
      view('our_fop', { status: 'pending' });

      const error = await failure(service.complete(manager, 'req1', body([row])));

      expect(error).toMatchObject({ status: HttpStatus.CONFLICT, code: 'not-accepted' });
      expect(cards.claimCompletion).not.toHaveBeenCalled();
      expect(orders.create).not.toHaveBeenCalled();
    });

    it('should not claim and answer 502 when finance gives no answer', async () => {
      finance.get.mockRejectedValue(new FinanceApiError(0, 'timeout'));

      const error = await failure(service.complete(manager, 'req1', body([row])));

      expect(error).toMatchObject({ status: HttpStatus.BAD_GATEWAY, code: 'finance-no-answer' });
      expect(cards.claimCompletion).not.toHaveBeenCalled();
    });

    it('should release the claim and rethrow when OrdersService fails', async () => {
      view('our_fop', { orders: [orderRow('0000-070217', '1000')] });
      const boom = new Error('db down');
      orders.create.mockRejectedValue(boom);

      await expect(service.complete(manager, 'req1', body([row]))).rejects.toBe(boom);

      expect(cards.releaseCompletion).toHaveBeenCalledWith('req1');
      expect(cards.setOrderIds).not.toHaveBeenCalled();
    });

    it('should answer 409 order-taken and release when the number appears meanwhile', async () => {
      view('our_fop', { orders: [orderRow('0000-070217', '1000')] });
      orders.create.mockRejectedValue(new OrderNumberTakenError('0000-070217'));

      const error = await failure(service.complete(manager, 'req1', body([row])));

      expect(error).toMatchObject({ status: HttpStatus.CONFLICT, code: 'order-taken' });
      expect(cards.releaseCompletion).toHaveBeenCalledWith('req1');
    });

    it('should keep the original error when releasing the claim fails too', async () => {
      view('our_fop', { orders: [orderRow('0000-070217', '1000')] });
      const boom = new Error('db down');
      orders.create.mockRejectedValue(boom);
      cards.releaseCompletion.mockRejectedValue(new Error('release failed'));

      await expect(service.complete(manager, 'req1', body([row]))).rejects.toBe(boom);
    });

    it('should NOT release the claim when the orders exist but their ids cannot be stored', async () => {
      view('our_fop', { orders: [orderRow('0000-070217', '1000')] });
      orders.create.mockResolvedValue(order(10, '0000-070217'));
      cards.setOrderIds.mockRejectedValue(new Error('db down'));

      await expect(service.complete(manager, 'req1', body([row]))).resolves.toMatchObject({
        orderNumbers: ['0000-070217'],
      });

      expect(cards.releaseCompletion).not.toHaveBeenCalled();
      expect(logError).toHaveBeenCalled();
    });

    it('should store the ids right after the orders, before the notice and the held receipts', async () => {
      view('our_fop', { orders: [orderRow('0000-070217', '600'), orderRow('0000-070218', '400')] });
      const created = [order(10, '0000-070217'), order(11, '0000-070218')];
      orders.createGroup.mockResolvedValue(created);

      await service.complete(manager, 'req1', body([row]));

      expect(receipts.attachHeld).toHaveBeenCalledWith(manager, 'req1', created[0]);
      const ids = cards.setOrderIds.mock.invocationCallOrder[0]!;
      expect(ids).toBeLessThan(receipts.attachHeld.mock.invocationCallOrder[0]!);
      expect(ids).toBeLessThan(sender.editMessage.mock.invocationCallOrder[0]!);
    });

    it('should store the ids before the admin notice', async () => {
      view('card', { orders: [orderRow('0000-070217', '1000')] });
      orders.create.mockResolvedValue(order(10, '0000-070217'));

      await service.complete(
        manager,
        'req1',
        body([{ payerName: 'Петренко', amount: '1000', date: '2026-11-04', time: '10:00' }]),
      );

      expect(cards.setOrderIds.mock.invocationCallOrder[0]).toBeLessThan(
        sender.sendToAdmins.mock.invocationCallOrder[0]!,
      );
    });

    it('should still answer when the held receipts cannot be attached', async () => {
      view('our_fop', { orders: [orderRow('0000-070217', '1000')] });
      orders.create.mockResolvedValue(order(10, '0000-070217'));
      receipts.attachHeld.mockRejectedValue(new Error('telegram down'));

      await expect(service.complete(manager, 'req1', body([row]))).resolves.toEqual({
        orderNumbers: ['0000-070217'],
        skipped: [],
        note: 'Квитанції не додано — надішліть їх ще раз відповіддю на картку.',
      });

      expect(sender.editMessage).toHaveBeenCalled();
      expect(logError).toHaveBeenCalled();
    });

    it('should NOT release the claim when the requisites fail, and still tell the admins with skipped', async () => {
      view('card', { orders: [orderRow('0000-070217', '600'), orderRow('0000-070218', '400')] });
      orders.findWithBalance.mockImplementation((number: string) =>
        Promise.resolve(number === '0000-070217' ? { order: order(3, '0000-070217') } : null),
      );
      orders.create.mockResolvedValue(order(11, '0000-070218'));
      requisites.addMany.mockRejectedValue(new Error('db down'));

      const result = await service.complete(
        manager,
        'req1',
        body([{ payerName: 'Петренко', amount: '400', date: '2026-11-04', time: '10:00' }]),
      );

      expect(result.orderNumbers).toEqual(['0000-070218']);
      expect(result.skipped).toEqual(['0000-070217']);
      expect(result.note).toContain('реквізити');
      expect(cards.releaseCompletion).not.toHaveBeenCalled();
      expect(cards.setOrderIds).toHaveBeenCalledWith('req1', [11]);
      const notice = (sender.sendToAdmins.mock.calls[0] as string[])[0]!;
      expect(notice).toContain('0000-070218');
      expect(notice).toContain('Не додано (уже є в системі): 0000-070217');
      expect(notice).not.toContain('Реквізити:');
    });

    it('should not release the claim when the admin notice fails', async () => {
      view('minus', { clientLabel: 'Гук Руслан' });
      orders.create.mockResolvedValue(order(10, 'MC-1'));
      sender.sendToAdmins.mockRejectedValue(new Error('telegram down'));

      await expect(
        service.complete(
          manager,
          'req1',
          body([{ amount: '1000', date: '2026-11-04', time: '10:00' }]),
        ),
      ).resolves.toMatchObject({ orderNumbers: ['MC-1'] });
      expect(cards.releaseCompletion).not.toHaveBeenCalled();
    });
  });
});
