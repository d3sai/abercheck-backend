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
import type { AttachmentsService } from '../../../src/modules/attachments/attachments.service';
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

/** The only button a completed card keeps while nothing is left to confirm. */
const ATTACH = [{ text: '📎 Прикріпити файли', callback_data: 'ma:req1' }];
const CANCEL = (number: string) => [
  { text: `🗑 Скасувати № ${number}`, callback_data: `del:${number}` },
];

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
    claimClosing: jest.fn(),
    releaseClosing: jest.fn(),
    heldFiles: jest.fn(),
  };
  const orders = {
    findWithBalance: jest.fn(),
    create: jest.fn(),
    createGroup: jest.fn(),
    setPaidAt: jest.fn(),
    setAdminMessageId: jest.fn(),
    numbersByIds: jest.fn(),
  };
  const requisites = { addMany: jest.fn(), fillPaidAt: jest.fn() };
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
    { save: jest.fn() } as unknown as AttachmentsService,
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
    cards.heldFiles.mockResolvedValue([]);
    orders.findWithBalance.mockResolvedValue(null);
    requisites.addMany.mockResolvedValue([]);
    requisites.fillPaidAt.mockResolvedValue(undefined);
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
      expect(cards.claimCompletion).toHaveBeenCalledWith('req1', expect.any(Date), true);
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

    it('should edit the manager card text with the order numbers and only «Прикріпити файли»', async () => {
      view('our_fop', {
        orders: [orderRow('0000-070217', '600'), orderRow('0000-070218', '400')],
      });
      orders.createGroup.mockResolvedValue([order(10, '0000-070217'), order(11, '0000-070218')]);

      await service.complete(manager, 'req1', body([{ amount: '1000', date: '2026-11-04' }]));

      expect(sender.editMessage).toHaveBeenCalledTimes(1);
      const [chat, message, html, buttons] = sender.editMessage.mock.calls[0] as unknown[];
      expect([chat, message, buttons]).toEqual([
        555n,
        77,
        [ATTACH, CANCEL('0000-070217'), CANCEL('0000-070218')],
      ]);
      expect(html).toContain('✅ Оформлено: № 0000-070217, 0000-070218 (2 замовлення)');
    });

    it('should show the date of payment on the completed card, with no «💰 Оплачено»', async () => {
      sender.miniAppUrl = 'https://cab.example.ua/tg/request';
      view('our_fop', one);
      orders.create.mockResolvedValue(order(10, '0000-070217'));

      await service.complete(manager, 'req1', body([{ amount: '1000', date: '2026-11-04' }]));

      const [, , html, buttons] = sender.editMessage.mock.calls[0] as unknown[];
      expect(html).toContain('✅ Оформлено: № 0000-070217');
      expect(html).toContain('✅ Оплачено 04.11.2026 00:00');
      expect(buttons).toEqual([ATTACH, CANCEL('0000-070217')]);
    });

    it('should refuse a form without a date, claiming nothing', async () => {
      view('our_fop', one);

      const error = await failure(service.complete(manager, 'req1', body([])));

      expect(error).toMatchObject({ status: HttpStatus.BAD_REQUEST, code: 'invalid-request' });
      expect(cards.claimCompletion).not.toHaveBeenCalled();
      expect(orders.create).not.toHaveBeenCalled();
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

  describe('foreign_fop', () => {
    const one = { orders: [orderRow('0000-070217', '1000')] };

    it('should create the order like our_fop: the form date, no payer rows, the task closed', async () => {
      view('foreign_fop', one);
      orders.create.mockResolvedValue(order(10, '0000-070217'));

      const result = await service.complete(
        manager,
        'req1',
        body([{ amount: '1000', date: '2026-11-04' }]),
      );

      expect(callArg(orders.create, 1)).toMatchObject({
        orderNumber: '0000-070217',
        clientName: 'ФОП Іванов',
        paidAt: kyivDateTime(2026, 11, 4),
      });
      expect(callArg(orders.create, 2)).toEqual({ notify: true, addPart: false });
      expect(requisites.addMany).not.toHaveBeenCalled();
      expect(cards.claimCompletion).toHaveBeenCalledWith('req1', expect.any(Date), true);
      expect(result).toEqual({ orderNumbers: ['0000-070217'], skipped: [] });
    });

    it('should refuse a form with several dates', async () => {
      view('foreign_fop', one);

      const error = await failure(
        service.complete(
          manager,
          'req1',
          body([
            { amount: '1', date: '2026-11-04' },
            { amount: '2', date: '2026-11-04' },
          ]),
        ),
      );

      expect(error).toMatchObject({ status: HttpStatus.BAD_REQUEST, code: 'invalid-request' });
      expect(cards.claimCompletion).not.toHaveBeenCalled();
    });
  });

  describe('card', () => {
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

    it.each<RequestKind>(['card'])(
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

    it('should start the day at Kyiv midnight when the manager gives no time', async () => {
      view('card', { orders: [orderRow('0000-070217', '1000')] });
      orders.create.mockResolvedValue(order(10, '0000-070217'));

      await service.complete(
        manager,
        'req1',
        body([{ payerName: 'Петренко Іван', amount: '1000', date: '2026-11-04' }]),
      );

      expect(requisites.addMany).toHaveBeenCalledWith(
        10,
        [expect.objectContaining({ paidAt: kyivDateTime(2026, 11, 4) })],
        expect.anything(),
      );
    });

    it('should answer 400 without a date', async () => {
      view('card', { orders: [orderRow('0000-070217', '1000')] });

      const error = await failure(
        service.complete(
          manager,
          'req1',
          body([{ payerName: 'Петренко Іван', amount: '1000', date: '' }]),
        ),
      );

      expect(error).toMatchObject({ status: HttpStatus.BAD_REQUEST, code: 'invalid-request' });
      expect(cards.claimCompletion).not.toHaveBeenCalled();
    });

    it('should answer 400 without a payer name', async () => {
      view('card', { orders: [orderRow('0000-070217', '1000')] });

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

  describe('minus', () => {
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

    it('should keep the id of the notice on the orders, so deleting an order can remove it', async () => {
      view('minus', {
        clientLabel: 'Гук Руслан',
        sheetUrl: 'https://sheet.example/1',
        withPercent: true,
        comment: null,
      });
      sender.sendToAdmins.mockResolvedValue(77);
      orders.create.mockResolvedValue(
        order(10, 'MC-1', { orderType: OrderType.MINUS_CLOSING, clientName: 'Гук Руслан' }),
      );

      await service.complete(manager, 'req1', body([row]));

      expect(orders.setAdminMessageId).toHaveBeenCalledWith([10], 77);
    });

    it('should start the day at Kyiv midnight when the manager gives no time', async () => {
      view('minus', { clientLabel: 'Гук Руслан' });
      orders.create.mockResolvedValue(order(10, 'MC-1', { orderType: OrderType.MINUS_CLOSING }));

      await service.complete(manager, 'req1', body([{ amount: '1000', date: '2026-11-04' }]));

      expect(orders.create).toHaveBeenCalledWith(
        4,
        expect.objectContaining({ paidAt: kyivDateTime(2026, 11, 4) }),
        { notify: false },
      );
    });

    it('should answer 400 for more than one payment row', async () => {
      view('minus', { clientLabel: 'Іваненко' });

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

      expect(receipts.attachHeld).toHaveBeenCalledWith(manager, 'req1', created[0], undefined);
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

    describe('with receipts held before the completion', () => {
      beforeEach(() => cards.heldFiles.mockResolvedValue([{ id: 1 }]));

      it('should create an our_fop order with notify off and send the order notice as the receipts caption', async () => {
        view('our_fop', { orders: [orderRow('0000-070217', '1000')] });
        orders.create.mockResolvedValue(order(10, '0000-070217'));

        await service.complete(manager, 'req1', body([row]));

        expect(callArg(orders.create, 2)).toEqual({ notify: false, addPart: false });
        expect(receipts.attachHeld).toHaveBeenCalledWith(
          manager,
          'req1',
          expect.objectContaining({ id: 10 }),
          expect.stringContaining('0000-070217'),
        );
        expect(sender.sendToAdmins).not.toHaveBeenCalled();
      });

      it('should merge a card notice into the caption instead of a separate message', async () => {
        view('card', { orders: [orderRow('0000-070217', '1000')] });
        orders.create.mockResolvedValue(order(10, '0000-070217'));

        await service.complete(
          manager,
          'req1',
          body([{ payerName: 'Іван', amount: '1000', date: '2026-11-04', time: '10:00' }]),
        );

        expect(receipts.attachHeld).toHaveBeenCalledWith(
          manager,
          'req1',
          expect.objectContaining({ id: 10 }),
          expect.stringContaining('Оплата на реквізити'),
        );
        expect(sender.sendToAdmins).not.toHaveBeenCalled();
      });

      it('should still tell the admins when the receipts cannot be attached', async () => {
        view('card', { orders: [orderRow('0000-070217', '1000')] });
        orders.create.mockResolvedValue(order(10, '0000-070217'));
        receipts.attachHeld.mockRejectedValue(new Error('telegram down'));

        await service.complete(
          manager,
          'req1',
          body([{ payerName: 'Іван', amount: '1000', date: '2026-11-04', time: '10:00' }]),
        );

        expect(sender.sendToAdmins).toHaveBeenCalledWith(
          expect.stringContaining('Оплата на реквізити'),
        );
      });
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

  describe('closing', () => {
    it.each<RequestKind>(['card'])(
      'should close a %s task with the completion and show the date of payment',
      async (kind) => {
        sender.miniAppUrl = 'https://cab.example.ua/tg/request';
        view(kind, { orders: [orderRow('0000-070217', '1000')] });
        orders.create.mockResolvedValue(order(10, '0000-070217'));

        await service.complete(
          manager,
          'req1',
          body([{ payerName: 'Іван', amount: '1000', date: '2026-11-04', time: '10:00' }]),
        );

        expect(cards.claimCompletion).toHaveBeenCalledWith('req1', expect.any(Date), true);
        const [, , html, buttons] = sender.editMessage.mock.calls[0] as unknown[];
        expect(html).toContain('✅ Оформлено: № 0000-070217');
        expect(html).toContain('✅ Оплачено 04.11.2026 10:00');
        expect(buttons).toEqual([ATTACH, CANCEL('0000-070217')]);
      },
    );

    it('should close a minus task with the completion', async () => {
      view('minus', { clientLabel: 'Гук Руслан' });
      orders.create.mockResolvedValue(order(10, 'MC-1'));

      await service.complete(
        manager,
        'req1',
        body([{ amount: '1000', date: '2026-11-04', time: '10:00' }]),
      );

      expect(cards.claimCompletion).toHaveBeenCalledWith('req1', expect.any(Date), true);
    });
  });

  describe('overrides', () => {
    const rows = (...pairs: [string, string, string][]) =>
      pairs.map(([orderNumber, amount, exchangeRate]) => ({ orderNumber, amount, exchangeRate }));
    const two = {
      orders: [orderRow('0000-070217', '600', '45'), orderRow('0000-070218', '400', '45')],
    };
    const pay = [{ payerName: 'Іван', amount: '1000', date: '2026-11-04', time: '10:00' }];

    it('should create the our_fop order with the amount and rate of the form', async () => {
      view('our_fop', { orders: [orderRow('0000-070217', '1000', '45')] });
      orders.create.mockResolvedValue(order(10, '0000-070217'));

      await service.complete(manager, 'req1', {
        payments: [{ amount: '1000', date: '2026-11-04' }],
        orders: rows([' 0000-070217 ', '1200.50', '46.5']),
        comment: ' нова примітка ',
      });

      expect(callArg(orders.create, 1)).toMatchObject({
        orderNumber: '0000-070217',
        amountDue: '1200.50',
        exchangeRate: '46.5',
        comment: 'нова примітка',
      });
    });

    it('should override each order of a group', async () => {
      view('our_fop', two);
      orders.createGroup.mockResolvedValue([order(10, '0000-070217'), order(11, '0000-070218')]);

      await service.complete(manager, 'req1', {
        payments: [{ amount: '1000', date: '2026-11-04' }],
        orders: rows(['0000-070218', '350', '44'], ['0000-070217', '650', '46']),
      });

      expect(callArg(orders.createGroup, 1)).toEqual([
        { orderNumber: '0000-070217', amountDue: '650.00', exchangeRate: '46' },
        { orderNumber: '0000-070218', amountDue: '350.00', exchangeRate: '44' },
      ]);
    });

    it('should override the amounts of a card order group and its rate', async () => {
      view('card', two);
      orders.createGroup.mockResolvedValue([order(10, '0000-070217'), order(11, '0000-070218')]);

      await service.complete(manager, 'req1', {
        payments: pay,
        orders: rows(['0000-070217', '650', '46'], ['0000-070218', '350', '44']),
      });

      expect(orders.createGroup).toHaveBeenCalled();
      expect(callArg(orders.createGroup, 1)).toEqual([
        { orderNumber: '0000-070217', amountDue: '650.00', exchangeRate: '46' },
        { orderNumber: '0000-070218', amountDue: '350.00', exchangeRate: '44' },
      ]);
    });

    it('should keep the request comment when none is sent and clear it for a blank one', async () => {
      view('our_fop', { orders: [orderRow('0000-070217', '1000', '45')] });
      orders.create.mockResolvedValue(order(10, '0000-070217'));

      await service.complete(manager, 'req1', {
        payments: [{ amount: '1000', date: '2026-11-04' }],
      });
      expect(callArg(orders.create, 1)).toMatchObject({ comment: 'терміново' });

      orders.create.mockClear();
      cards.byRequestId.mockResolvedValue(card);
      await service.complete(manager, 'req1', {
        payments: [{ amount: '1000', date: '2026-11-04' }],
        comment: '  ',
      });
      expect(callArg(orders.create, 1)).toMatchObject({ comment: undefined });
    });

    it('should add the answer «з урахуванням %» to the order comment', async () => {
      view('our_fop', {
        orders: [orderRow('0000-070217', '1000', '45')],
        withPercent: true,
      });
      orders.create.mockResolvedValue(order(10, '0000-070217'));

      await service.complete(manager, 'req1', {
        payments: [{ amount: '1000', date: '2026-11-04' }],
      });

      expect(callArg(orders.create, 1)).toMatchObject({
        comment: 'терміново · з урахуванням %: так',
      });
    });

    it('should keep the numbers of finance on the manager card', async () => {
      view('our_fop', { orders: [orderRow('0000-070217', '1000', '45')] });
      orders.create.mockResolvedValue(order(10, '0000-070217'));

      await service.complete(manager, 'req1', {
        payments: [{ amount: '1000', date: '2026-11-04' }],
        orders: rows(['0000-070217', '1200', '46']),
      });

      const [, , html] = sender.editMessage.mock.calls[0] as unknown[];
      expect(html).toContain('1 000');
    });

    it('should put the form comment on a minus order', async () => {
      view('minus', { clientLabel: 'Гук Руслан', withPercent: true });
      orders.create.mockResolvedValue(order(10, 'MC-1'));

      await service.complete(manager, 'req1', {
        payments: [{ amount: '1000', date: '2026-11-04', time: '10:00' }],
        comment: 'з таблиці',
      });

      expect(callArg(orders.create, 1)).toMatchObject({
        comment: 'з таблиці · з урахуванням %: так',
      });
    });

    it.each([
      ['an unknown number', rows(['0000-070217', '600', '45'], ['0000-099999', '400', '45'])],
      ['a missing number', rows(['0000-070217', '600', '45'])],
      [
        'a repeated number',
        rows(['0000-070217', '600', '45'], ['0000-070217', '400', '45'], ['0000-070218', '1', '1']),
      ],
      ['a bad amount', rows(['0000-070217', '6,5', '45'], ['0000-070218', '400', '45'])],
      ['a bad rate', rows(['0000-070217', '600', '2000'], ['0000-070218', '400', '45'])],
      ['an empty list', []],
    ])('should answer 400 and claim nothing for %s', async (_, overrides) => {
      view('card', two);

      const error = await failure(
        service.complete(manager, 'req1', { payments: pay, orders: overrides }),
      );

      expect(error).toMatchObject({ status: HttpStatus.BAD_REQUEST, code: 'invalid-request' });
      expect(cards.claimCompletion).not.toHaveBeenCalled();
      expect(orders.create).not.toHaveBeenCalled();
      expect(orders.createGroup).not.toHaveBeenCalled();
    });

    it('should refuse numbers for a minus request, which has none', async () => {
      view('minus', { clientLabel: 'Гук Руслан' });

      const error = await failure(
        service.complete(manager, 'req1', {
          payments: [{ amount: '1000', date: '2026-11-04', time: '10:00' }],
          orders: rows(['0000-070217', '600', '45']),
        }),
      );

      expect(error).toMatchObject({ status: HttpStatus.BAD_REQUEST });
      expect(cards.claimCompletion).not.toHaveBeenCalled();
    });
  });

  describe('payments of the form', () => {
    it('should refuse a payment in the future', async () => {
      view('card', { orders: [orderRow('0000-070217', '1000')] });

      const error = await failure(
        service.complete(
          manager,
          'req1',
          body([{ payerName: 'Іван', amount: '1', date: '2999-01-01', time: '10:00' }]),
        ),
      );

      expect(error).toMatchObject({ status: HttpStatus.BAD_REQUEST, code: 'invalid-request' });
      expect(cards.claimCompletion).not.toHaveBeenCalled();
    });

    it.each<RequestKind>(['our_fop', 'foreign_fop', 'card', 'minus'])(
      'should refuse no payments at all for %s',
      async (kind) => {
        view(kind, { orders: kind === 'minus' ? [] : [orderRow('0000-070217', '1000')] });

        const error = await failure(service.complete(manager, 'req1', body([])));

        expect(error).toMatchObject({ status: HttpStatus.BAD_REQUEST, code: 'invalid-request' });
        expect(cards.claimCompletion).not.toHaveBeenCalled();
      },
    );
  });

  describe('accept', () => {
    const stored = [
      {
        payerName: 'Петренко Іван',
        account: '4441111069645962',
        amount: '700.00',
        paidAt: '2026-11-04T08:15:00.000Z',
      },
      {
        payerName: 'Петренко Ірина',
        account: null,
        amount: '300.00',
        paidAt: '2026-11-04T09:00:00.000Z',
      },
    ];
    const withStored = (payments: unknown) =>
      cards.byRequestId.mockResolvedValue({ ...card, payments });

    it.each<RequestKind>(['card'])(
      'should create the %s orders with the stored payments and the request comment',
      async (kind) => {
        withStored(stored);
        view(kind, { orders: [orderRow('0000-070217', '1000', '45')] });
        orders.create.mockResolvedValue(order(10, '0000-070217'));

        const result = await service.accept(manager, 'req1');

        expect(result).toEqual({ orderNumbers: ['0000-070217'], skipped: [] });
        expect(callArg(orders.create, 1)).toMatchObject({
          orderNumber: '0000-070217',
          amountDue: '1000.00',
          exchangeRate: '45',
          comment: 'терміново',
        });
        expect(requisites.addMany).toHaveBeenCalledWith(
          10,
          [
            {
              payerName: 'Петренко Іван',
              account: '4441111069645962',
              amount: '700.00',
              paidAt: new Date('2026-11-04T08:15:00.000Z'),
            },
            {
              payerName: 'Петренко Ірина',
              account: null,
              amount: '300.00',
              paidAt: new Date('2026-11-04T09:00:00.000Z'),
            },
          ],
          { telegramId: 555n, name: 'Уляна' },
        );
        expect(sender.sendToAdmins).toHaveBeenCalledWith(
          expect.stringContaining('Оплата на реквізити'),
        );
        expect(cards.claimCompletion).toHaveBeenCalledWith('req1', expect.any(Date), true);
        expect(cards.setOrderIds).toHaveBeenCalledWith('req1', [10]);
        expect(receipts.attachHeld).toHaveBeenCalled();
      },
    );

    it('should create MINUS_CLOSING with the stored payment date and close the task', async () => {
      withStored([
        { payerName: null, account: null, amount: '1000.00', paidAt: '2026-11-04T07:05:00.000Z' },
      ]);
      view('minus', { clientLabel: 'Гук Руслан', comment: null });
      orders.create.mockResolvedValue(order(10, 'MC-1'));

      await service.accept(manager, 'req1');

      expect(callArg(orders.create, 1)).toMatchObject({
        orderType: OrderType.MINUS_CLOSING,
        paidAt: new Date('2026-11-04T07:05:00.000Z'),
      });
      expect(cards.claimCompletion).toHaveBeenCalledWith('req1', expect.any(Date), true);
      expect(sender.sendToAdmins).toHaveBeenCalled();
    });

    it.each<RequestKind>(['our_fop', 'foreign_fop'])(
      'should refuse %s without a date: the form asks for it',
      async (kind) => {
        view(kind, { orders: [orderRow('0000-070217', '1000', '45')] });

        const error = await failure(service.accept(manager, 'req1'));

        expect(error).toMatchObject({ status: HttpStatus.BAD_REQUEST, code: 'no-payment-date' });
        expect(cards.claimCompletion).not.toHaveBeenCalled();
      },
    );

    it('should redraw a stale card with the form button when a date is missing', async () => {
      sender.miniAppUrl = 'https://cab.example.ua/tg/request';
      withStored([{ payerName: null, account: null, amount: '1000.00', paidAt: null }]);
      view('card', { orders: [orderRow('0000-070217', '1000')] });

      await failure(service.accept(manager, 'req1'));

      const [chat, message, , buttons] = sender.editMessage.mock.calls[0] as unknown[];
      expect([chat, message]).toEqual([555n, 77]);
      expect(JSON.stringify(buttons)).toContain('web_app');
      expect(JSON.stringify(buttons)).not.toContain('mo:');
    });

    it('should redraw the manager card as completed', async () => {
      withStored(stored);
      view('card', { orders: [orderRow('0000-070217', '1000')] });
      orders.create.mockResolvedValue(order(10, '0000-070217'));

      await service.accept(manager, 'req1');

      const [chat, message, html, buttons] = sender.editMessage.mock.calls[0] as unknown[];
      expect([chat, message, buttons]).toEqual([555n, 77, [ATTACH, CANCEL('0000-070217')]]);
      expect(html).toContain('✅ Оформлено: № 0000-070217');
    });

    it.each<RequestKind>(['card', 'minus'])(
      'should refuse %s without stored payments, claiming nothing',
      async (kind) => {
        view(kind, { orders: kind === 'minus' ? [] : [orderRow('0000-070217', '1000')] });

        const error = await failure(service.accept(manager, 'req1'));

        expect(error).toMatchObject({ status: HttpStatus.BAD_REQUEST, code: 'no-payment-date' });
        expect(cards.claimCompletion).not.toHaveBeenCalled();
      },
    );

    it('should be safe to press twice: the second press creates nothing', async () => {
      withStored(stored);
      view('card', { orders: [orderRow('0000-070217', '1000')] });
      orders.create.mockResolvedValue(order(10, '0000-070217'));
      await service.accept(manager, 'req1');
      cards.byRequestId.mockResolvedValue({ ...card, payments: stored, completedAt: new Date() });

      const error = await failure(service.accept(manager, 'req1'));

      expect(error).toMatchObject({ status: HttpStatus.CONFLICT, code: 'already-completed' });
      expect(orders.create).toHaveBeenCalledTimes(1);
    });

    it('should lose a race at the claim without creating orders', async () => {
      withStored(stored);
      view('card', { orders: [orderRow('0000-070217', '1000')] });
      cards.claimCompletion.mockResolvedValue(false);

      const error = await failure(service.accept(manager, 'req1'));

      expect(error).toMatchObject({ status: HttpStatus.CONFLICT, code: 'already-completed' });
      expect(orders.create).not.toHaveBeenCalled();
    });

    it('should offer a part, not add one, for an existing number', async () => {
      withStored(stored);
      view('card', { orders: [orderRow('0000-070217', '1000')] });
      orders.findWithBalance.mockResolvedValue({
        order: order(3, '0000-070217'),
        amountPaid: new Prisma.Decimal('0'),
      });

      const error = await failure(service.accept(manager, 'req1'));

      expect(error).toMatchObject({ status: HttpStatus.CONFLICT, code: 'order-exists-part' });
      expect(orders.create).not.toHaveBeenCalled();
    });

    it('should answer 404 for the request of another manager', async () => {
      cards.byRequestId.mockResolvedValue({ ...card, managerId: 9 });

      const error = await failure(service.accept(manager, 'req1'));

      expect(error).toMatchObject({ status: HttpStatus.NOT_FOUND });
    });
  });

  describe('markPaid', () => {
    const done = { ...card, completedAt: new Date('2026-11-04T10:00:00Z'), orderIds: [10, 11] };
    const when = { date: '2026-11-04', time: '14:30' };
    const paidAt = kyivDateTime(2026, 11, 4, 14, 30);

    beforeEach(() => {
      cards.byRequestId.mockResolvedValue(done);
      cards.claimClosing.mockResolvedValue(true);
      cards.releaseClosing.mockResolvedValue(undefined);
      orders.setPaidAt.mockResolvedValue(undefined);
      orders.numbersByIds.mockResolvedValue(['0000-070217', '0000-070218']);
      view('our_fop');
    });

    it('should stamp every order and redraw the card', async () => {
      sender.miniAppUrl = 'https://cab.example.ua/tg/request';

      const result = await service.markPaid(manager, 'req1', when);

      expect(result).toEqual({ paidAt: paidAt.toISOString() });
      expect(orders.setPaidAt).toHaveBeenCalledWith([10, 11], paidAt);
      expect(requisites.fillPaidAt).toHaveBeenCalledWith([10, 11], paidAt);
      const [chat, message, html, buttons] = sender.editMessage.mock.calls[0] as unknown[];
      expect([chat, message, buttons]).toEqual([
        555n,
        77,
        [ATTACH, CANCEL('0000-070217'), CANCEL('0000-070218')],
      ]);
      expect(html).toContain('✅ Оформлено: № 0000-070217, 0000-070218');
      expect(html).toContain('✅ Оплачено 04.11.2026 14:30');
    });

    it('should start the day at Kyiv midnight without a time', async () => {
      await service.markPaid(manager, 'req1', { date: '2026-11-04' });

      expect(orders.setPaidAt).toHaveBeenCalledWith([10, 11], kyivDateTime(2026, 11, 4));
    });

    it('should answer 404 for the request of another manager', async () => {
      cards.byRequestId.mockResolvedValue({ ...done, managerId: 9 });

      const error = await failure(service.markPaid(manager, 'req1', when));

      expect(error).toMatchObject({ status: HttpStatus.NOT_FOUND, code: 'not-found' });
      expect(orders.setPaidAt).not.toHaveBeenCalled();
    });

    it('should answer 409 not-completed before the orders exist', async () => {
      cards.byRequestId.mockResolvedValue(card);

      const error = await failure(service.markPaid(manager, 'req1', when));

      expect(error).toMatchObject({ status: HttpStatus.CONFLICT, code: 'not-completed' });
      expect(cards.claimClosing).not.toHaveBeenCalled();
    });

    it('should stamp a foreign_fop task the same way', async () => {
      view('foreign_fop');

      await service.markPaid(manager, 'req1', when);

      expect(orders.setPaidAt).toHaveBeenCalledWith([10, 11], paidAt);
    });

    it.each<RequestKind>(['card', 'minus'])(
      'should stamp the orders and payments of %s without closing it again',
      async (kind) => {
        cards.byRequestId.mockResolvedValue({ ...done, closedAt: new Date() });
        view(kind);
        sender.miniAppUrl = 'https://cab.example.ua/tg/request';

        await service.markPaid(manager, 'req1', when);

        expect(cards.claimClosing).not.toHaveBeenCalled();
        expect(orders.setPaidAt).toHaveBeenCalledWith([10, 11], paidAt);
        expect(requisites.fillPaidAt).toHaveBeenCalledWith([10, 11], paidAt);
        const [, , html, buttons] = sender.editMessage.mock.calls[0] as unknown[];
        expect(html).toContain('✅ Оплачено 04.11.2026 14:30');
        expect(buttons).toEqual([ATTACH, CANCEL('0000-070217'), CANCEL('0000-070218')]);
      },
    );

    it.each([
      ['a date in the future', { date: '2999-01-01' }],
      ['a time in the future today', { date: '2999-01-01', time: '00:01' }],
      ['a malformed date', { date: '04.11.2026' }],
      ['a day the calendar does not have', { date: '2026-02-30' }],
      ['a bad time', { date: '2026-11-04', time: '25:00' }],
    ])('should answer 400 for %s', async (_, dto) => {
      const error = await failure(service.markPaid(manager, 'req1', dto));

      expect(error).toMatchObject({ status: HttpStatus.BAD_REQUEST, code: 'invalid-request' });
      expect(cards.claimClosing).not.toHaveBeenCalled();
      expect(orders.setPaidAt).not.toHaveBeenCalled();
    });

    it('should still answer when the card cannot be redrawn', async () => {
      sender.editMessage.mockRejectedValue(new Error('telegram down'));

      await expect(service.markPaid(manager, 'req1', when)).resolves.toEqual({
        paidAt: paidAt.toISOString(),
      });
      expect(cards.releaseClosing).not.toHaveBeenCalled();
    });
  });
});
