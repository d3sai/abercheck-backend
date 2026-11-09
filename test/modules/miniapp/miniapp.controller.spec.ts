import { HttpStatus, Logger } from '@nestjs/common';
import { ApiError } from '../../../src/common/api-error';
import {
  Currency,
  type FinanceRequestCard,
  type Manager,
  Prisma,
} from '../../../src/generated/prisma/client';
import type { FinanceClient } from '../../../src/modules/finance-sync/finance.client';
import { FinanceApiError } from '../../../src/modules/finance-sync/finance.types';
import type {
  FinanceRequestView,
  RequestKind,
} from '../../../src/modules/finance-sync/finance.types';
import type { RequestCardsRepository } from '../../../src/modules/finance-sync/request-cards.repository';
import type { RequestCreateService } from '../../../src/modules/finance-sync/request-create.service';
import type { KitPlan } from '../../../src/modules/telegram/order-draft/kit.parser';
import type { DirectOrdersService } from '../../../src/modules/miniapp/direct-orders.service';
import type { RequestCompletionService } from '../../../src/modules/miniapp/request-completion.service';
import type { RequestSyncService } from '../../../src/modules/finance-sync/request-sync.service';
import { MiniappController } from '../../../src/modules/miniapp/miniapp.controller';
import type {
  CreateMiniappOrderDto,
  OrderPlan,
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
  const completion = { complete: jest.fn(), markPaid: jest.fn() };
  const directOrders = { create: jest.fn() };
  const controller = new MiniappController(
    requests as unknown as RequestCreateService,
    finance as unknown as FinanceClient,
    cards as unknown as RequestCardsRepository,
    sync as unknown as RequestSyncService,
    completion as unknown as RequestCompletionService,
    directOrders as unknown as DirectOrdersService,
  );

  beforeEach(() => {
    requests.create.mockResolvedValue({ ok: true, requestId: 'req1', number: '42', note: null });
    cards.byRequestId.mockResolvedValue(card);
    finance.get.mockResolvedValue({ request: view });
    finance.edit.mockResolvedValue(view);
  });

  afterEach(() => jest.resetAllMocks());

  describe('create', () => {
    const order = { orderNumber: '0000-070217', amount: '4972', exchangeRate: '45' };
    const paid = {
      payerName: ' Петренко Іван ',
      amount: '4972',
      date: '2026-11-04',
      time: '10:15',
    };
    const stored = {
      payerName: 'Петренко Іван',
      account: null,
      amount: '4972.00',
      paidAt: '2026-11-04T08:15:00.000Z',
    };
    // a payment row goes with card and minus; our_fop and foreign_fop pay after confirming
    const base = { officialDocs: true, payments: [paid] };
    const create = (dto: Partial<CreateMiniappRequestDto>) =>
      controller.create(manager, { ...base, ...dto } as CreateMiniappRequestDto);

    it('should pass an our_fop request with a normalised number to the service', async () => {
      const answer = await create({
        kind: 'our_fop',
        orders: [{ ...order, orderNumber: ' 0000-070217 ', exchangeRate: '45.7' }],
        comment: ' Терміново ',
        payments: undefined,
      });

      expect(answer).toEqual({ requestId: 'req1', number: '42' });
      expect(requests.create).toHaveBeenCalledWith(manager, {
        kind: 'our_fop',
        orders: [{ orderNumber: '0000-070217', amount: '4972', exchangeRate: '45.7' }],
        comment: 'Терміново',
        officialDocs: true,
      });
    });

    it('should keep two foreign_fop orders with a rate per row', async () => {
      await create({
        kind: 'foreign_fop',
        payments: undefined,
        orders: [
          { ...order, exchangeRate: '44.5' },
          { orderNumber: '0000-072611', amount: '11124.50', exchangeRate: '45.1' },
        ],
      });

      expect(requests.create).toHaveBeenCalledWith(
        manager,
        expect.objectContaining({
          kind: 'foreign_fop',
          orders: [
            { orderNumber: '0000-070217', amount: '4972', exchangeRate: '44.5' },
            { orderNumber: '0000-072611', amount: '11124.50', exchangeRate: '45.1' },
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
        payments: [{ amount: '1500.5', date: '2026-11-04', time: '09:05' }],
      });

      expect(requests.create).toHaveBeenCalledWith(manager, {
        kind: 'minus',
        sum: '1500.50',
        clientLabel: 'Іван',
        sheetUrl: 'https://s/1',
        withPercent: true,
        comment: null,
        officialDocs: false,
        payments: [
          { payerName: null, account: null, amount: '1500.50', paidAt: '2026-11-04T07:05:00.000Z' },
        ],
      });
    });

    it('should keep the payment time unknown when the manager gives no date', async () => {
      await create({
        kind: 'minus',
        sum: '100',
        clientLabel: 'Іван',
        payments: [{ amount: '100' }],
      });

      expect(requests.create).toHaveBeenCalledWith(
        manager,
        expect.objectContaining({
          payments: [{ payerName: null, account: null, amount: '100.00', paidAt: null }],
        }),
      );
    });

    it('should treat null optional fields as absent on create', async () => {
      await create({
        kind: 'card',
        orders: [order],
        comment: null,
      } as unknown as Partial<CreateMiniappRequestDto>);

      expect(requests.create).toHaveBeenCalledWith(
        manager,
        expect.objectContaining({ comment: null }),
      );
    });

    it.each(['foreign_fop', 'card'] as RequestKind[])(
      'should send %s without official documents whatever the form says',
      async (kind) => {
        await create({
          kind,
          orders: [order],
          officialDocs: true,
          payments: kind === 'card' ? [paid] : undefined,
        });

        expect(requests.create).toHaveBeenCalledWith(
          manager,
          expect.objectContaining({ kind, officialDocs: false }),
        );
      },
    );

    it('should not require a rate for minus', async () => {
      await create({
        kind: 'minus',
        sum: '100',
        clientLabel: 'A',
        payments: [{ amount: '100', date: '2026-11-04', time: '09:05' }],
      });

      expect(requests.create).toHaveBeenCalledWith(
        manager,
        expect.objectContaining({ kind: 'minus' }),
      );
    });

    it.each([['our_fop'], ['foreign_fop'], ['card']] as [RequestKind][])(
      'should answer 400 for a %s order number without its rate',
      async (kind) => {
        for (const exchangeRate of [undefined, '  ']) {
          const error = await failure(create({ kind, orders: [{ ...order, exchangeRate }] }));

          expect(error).toMatchObject({
            status: 400,
            code: 'invalid-request',
            message: 'Вкажіть курс для № 0000-070217.',
          });
        }
        expect(requests.create).not.toHaveBeenCalled();
      },
    );

    it.each([
      ['minus without clientLabel', { kind: 'minus', sum: '100' }],
      ['minus with a blank clientLabel', { kind: 'minus', sum: '100', clientLabel: '  ' }],
      ['minus with a bad sum', { kind: 'minus', sum: '10,5', clientLabel: 'A' }],
      ['our_fop without orders', { kind: 'our_fop' }],
      ['our_fop with 21 orders', { kind: 'our_fop', orders: Array(21).fill(order) }],
      ['a bad order number', { kind: 'card', orders: [{ ...order, orderNumber: '070217' }] }],
      ['a bad amount', { kind: 'card', orders: [{ ...order, amount: '0' }] }],
      ['a bad row rate', { kind: 'card', orders: [{ ...order, exchangeRate: 'abc' }] }],
      ['a rate above 1000', { kind: 'card', orders: [{ ...order, exchangeRate: '1001' }] }],
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

    it('should pass the normalised payments of a card request', async () => {
      await create({
        kind: 'card',
        orders: [order],
        payments: [
          { ...paid, account: ' 4441111069645962 ' },
          { ...paid, amount: '1.5' },
        ],
      });

      expect(requests.create).toHaveBeenCalledWith(
        manager,
        expect.objectContaining({
          payments: [
            { ...stored, account: '4441111069645962' },
            { ...stored, amount: '1.50' },
          ],
        }),
      );
    });

    it.each(['our_fop', 'foreign_fop'] as RequestKind[])(
      'should send a %s request without payments',
      async (kind) => {
        await create({ kind, orders: [order], payments: [] });

        expect(requests.create).toHaveBeenCalledWith(
          manager,
          expect.not.objectContaining({ payments: expect.anything() as unknown }),
        );
      },
    );

    it.each([
      ['our_fop with a payment', { kind: 'our_fop', orders: [order] }],
      ['foreign_fop with a payment', { kind: 'foreign_fop', orders: [order] }],
      ['card without payments', { kind: 'card', orders: [order], payments: undefined }],
      [
        'card without a payer name',
        { kind: 'card', orders: [order], payments: [{ ...paid, payerName: ' ' }] },
      ],
      [
        'card with a time but no date',
        { kind: 'card', orders: [order], payments: [{ ...paid, date: undefined }] },
      ],
      [
        'card with eleven payments',
        { kind: 'card', orders: [order], payments: Array(11).fill(paid) },
      ],
      [
        'card with a payment in the future',
        { kind: 'card', orders: [order], payments: [{ ...paid, date: '2999-01-01' }] },
      ],
      [
        'card with a bad amount',
        { kind: 'card', orders: [order], payments: [{ ...paid, amount: '1,5' }] },
      ],
      ['minus without a payment', { kind: 'minus', sum: '100', clientLabel: 'A', payments: [] }],
      [
        'minus with two payments',
        {
          kind: 'minus',
          sum: '100',
          clientLabel: 'A',
          payments: Array(2).fill({ amount: '50', date: '2026-11-04', time: '09:05' }),
        },
      ],
      [
        'minus whose payment is not the sum',
        {
          kind: 'minus',
          sum: '100',
          clientLabel: 'A',
          payments: [{ amount: '99', date: '2026-11-04', time: '09:05' }],
        },
      ],
    ] as [string, Partial<CreateMiniappRequestDto>][])(
      'should answer 400 and not create for %s',
      async (_, dto) => {
        const error = await failure(create(dto));

        expect(error).toMatchObject({ status: 400, code: 'invalid-request' });
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
    it('should return the view, the manager name, completed, closed and no payments', async () => {
      await expect(controller.get(manager, 'req1')).resolves.toEqual({
        request: view,
        managerName: 'Уляна',
        completed: false,
        closed: false,
        payments: [],
      });
      expect(finance.get).toHaveBeenCalledWith('req1');
    });

    it('should return the stored payments as Kyiv date and time', async () => {
      cards.byRequestId.mockResolvedValue({
        ...card,
        payments: [
          {
            payerName: 'Петренко Іван',
            account: '4441111069645962',
            amount: '700.00',
            paidAt: '2026-11-04T08:15:00.000Z',
          },
          { payerName: null, account: null, amount: '5.50', paidAt: '2026-07-01T21:30:00.000Z' },
        ],
      });

      const answer = await controller.get(manager, 'req1');

      expect(answer.payments).toEqual([
        {
          payerName: 'Петренко Іван',
          account: '4441111069645962',
          amount: '700.00',
          date: '2026-11-04',
          time: '10:15',
        },
        { payerName: null, account: null, amount: '5.50', date: '2026-07-02', time: '00:30' },
      ]);
    });

    it('should report closed for a closed card', async () => {
      cards.byRequestId.mockResolvedValue({
        ...card,
        completedAt: new Date(),
        closedAt: new Date(),
      });

      await expect(controller.get(manager, 'req1')).resolves.toMatchObject({
        completed: true,
        closed: true,
      });
    });

    it('should keep a completed our_fop open until it is paid', async () => {
      finance.get.mockResolvedValue({ request: { ...view, kind: 'our_fop' } });
      cards.byRequestId.mockResolvedValue({ ...card, completedAt: new Date(), closedAt: null });

      await expect(controller.get(manager, 'req1')).resolves.toMatchObject({
        completed: true,
        closed: false,
      });
    });

    it('should count a completed card of another kind closed even without closedAt', async () => {
      finance.get.mockResolvedValue({ request: { ...view, kind: 'card' } });
      cards.byRequestId.mockResolvedValue({ ...card, completedAt: new Date(), closedAt: null });

      await expect(controller.get(manager, 'req1')).resolves.toMatchObject({ closed: true });
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

  describe('createOrders', () => {
    const answer = { orderNumbers: ['0000-070217'], skipped: [] };
    const when = { date: '2026-01-15', time: '14:30' };
    const paidAt = new Date('2026-01-15T12:30:00.000Z');
    const send = (dto: Partial<CreateMiniappOrderDto>) =>
      controller.createOrders(manager, dto as CreateMiniappOrderDto);

    const planPassed = () => directOrders.create.mock.calls[0] as [Manager, OrderPlan];

    beforeEach(() => directOrders.create.mockResolvedValue(answer));

    describe('kit', () => {
      const kit = {
        kind: 'kit' as const,
        accessCode: ' 647143353 ',
        items: [
          { orderNumber: ' 0000-062265 ', amount: '2696.71' },
          { orderNumber: '0000-062937', amount: '480' },
        ],
        ...when,
      };

      it('should pass a plan with the total of the items and the Kyiv time', async () => {
        await expect(send({ ...kit, comment: ' до обіду ' })).resolves.toBe(answer);

        const [passedManager, order] = planPassed();
        expect(passedManager).toBe(manager);
        expect(order.kind).toBe('kit');
        expect(order.plan).toMatchObject({
          accessCode: '647143353',
          items: [
            { number: '0000-062265', amount: new Prisma.Decimal('2696.71') },
            { number: '0000-062937', amount: new Prisma.Decimal('480') },
          ],
          paidAt,
          comment: 'до обіду',
          warnings: [],
        });
        expect((order.plan as KitPlan).total.toFixed(2)).toBe('3176.71');
      });

      it.each([
        ['no code', { accessCode: ' ' }, 'Вкажіть код доступу.'],
        ['no items', { items: [] }, 'Додайте від 1 до 20 замовлень.'],
        [
          'twenty-one items',
          {
            items: Array.from({ length: 21 }, (_, i) => ({
              orderNumber: `0000-0${60000 + i}`,
              amount: '1',
            })),
          },
          'Додайте від 1 до 20 замовлень.',
        ],
        [
          'a repeated number',
          {
            items: [
              { orderNumber: '0000-062265', amount: '1' },
              { orderNumber: ' 0000-062265 ', amount: '2' },
            ],
          },
          'Номер 0000-062265 повторюється.',
        ],
        [
          'a short number',
          { items: [{ orderNumber: '000-062265', amount: '1' }] },
          'Бракує цифри. Може, 0000-062265?',
        ],
        [
          'a bad amount',
          { items: [{ orderNumber: '0000-062265', amount: '1,5' }] },
          'Вкажіть суму числом, до копійок: 6158.41',
        ],
        ['no time', { time: undefined }, 'Вкажіть дату й час оплати.'],
      ])('should refuse %s with a 400', async (_name, patch, message) => {
        expect(await failure(send({ ...kit, ...patch }))).toMatchObject({
          status: 400,
          code: 'invalid-request',
          message,
        });
        expect(directOrders.create).not.toHaveBeenCalled();
      });
    });

    describe('cash', () => {
      const cash = {
        kind: 'cash' as const,
        orderNumber: '0000-066498',
        amount: '4260',
        currency: Currency.UAH,
        rate: '44,9',
        handedBy: ' Христина Павлів ',
        ...when,
      };

      it('should pass a plan with a normalised rate and no percent by default', async () => {
        await send(cash);

        expect(planPassed()[1]).toEqual({
          kind: 'cash',
          plan: {
            number: '0000-066498',
            amount: new Prisma.Decimal('4260'),
            currency: 'UAH',
            rate: '44.9',
            paidAt,
            handedBy: 'Христина Павлів',
            withPercent: null,
            comment: null,
            warnings: [],
          },
        });
      });

      it('should pass withPercent, a dollar amount and the comment', async () => {
        await send({
          ...cash,
          currency: Currency.USD,
          withPercent: false,
          comment: 'у конверті',
        });

        expect(planPassed()[1].plan).toMatchObject({
          currency: 'USD',
          withPercent: false,
          comment: 'у конверті',
        });
      });

      it.each([
        ['no rate', { rate: undefined }, 'Вкажіть курс числом до 1000: 44.9'],
        ['a rate over 1000', { rate: '1000.5' }, 'Вкажіть курс числом до 1000: 44.9'],
        ['a rate that is not a number', { rate: 'abc' }, 'Вкажіть курс числом до 1000: 44.9'],
        ['no handedBy', { handedBy: ' ' }, 'Вкажіть, ким передано.'],
        ['euros', { currency: Currency.EUR }, 'Оберіть валюту: UAH, USD.'],
        ['no currency', { currency: undefined }, 'Оберіть валюту: UAH, USD.'],
        ['no time', { time: undefined }, 'Вкажіть дату й час оплати.'],
        ['a zero amount', { amount: '0' }, 'Вкажіть суму числом, до копійок: 6158.41'],
        ['a day the calendar lacks', { date: '2026-02-30' }, 'Такої дати немає: 2026-02-30.'],
        [
          'a date in the wrong shape',
          { date: '15.01.2026' },
          'Вкажіть дату як 2026-11-04, час як 14:30.',
        ],
      ])('should refuse %s with a 400', async (_name, patch, message) => {
        expect(await failure(send({ ...cash, ...patch }))).toMatchObject({
          status: 400,
          code: 'invalid-request',
          message,
        });
        expect(directOrders.create).not.toHaveBeenCalled();
      });

      it('should refuse a date in the future', async () => {
        expect(await failure(send({ ...cash, date: '2999-01-01' }))).toMatchObject({
          status: 400,
          code: 'invalid-request',
          message: 'Дата й час оплати не можуть бути в майбутньому.',
        });
      });
    });

    describe('foreign', () => {
      const foreign = {
        kind: 'foreign' as const,
        orderNumber: '0000-066498',
        amount: '100',
        currency: Currency.EUR,
        recipient: ' Абертайм ТОВ ',
        rate: '44.9',
        date: '2026-01-15',
      };

      it('should pass a plan; without a time the day starts at Kyiv midnight', async () => {
        await send({ ...foreign, comment: ' за товар ' });

        expect(planPassed()[1]).toEqual({
          kind: 'foreign',
          plan: {
            number: '0000-066498',
            amount: new Prisma.Decimal('100'),
            currency: 'EUR',
            recipient: 'Абертайм ТОВ',
            rate: '44.9',
            paidAt: new Date('2026-01-14T22:00:00.000Z'),
            comment: 'за товар',
            warnings: [],
          },
        });
      });

      it('should use the time when it is given', async () => {
        await send({ ...foreign, time: '09:05' });

        expect(planPassed()[1].plan.paidAt).toEqual(new Date('2026-01-15T07:05:00.000Z'));
      });

      it.each([
        ['no recipient', { recipient: '' }, 'Вкажіть, на кого оплата.'],
        ['no rate', { rate: ' ' }, 'Вкажіть курс числом до 1000: 44.9'],
        ['a bad time', { time: '25:00' }, 'Вкажіть дату як 2026-11-04, час як 14:30.'],
        ['no currency', { currency: undefined }, 'Оберіть валюту: UAH, USD, EUR.'],
        ['a bad number', { orderNumber: '66498' }, 'Номер має бути у форматі 0000-066717.'],
      ])('should refuse %s with a 400', async (_name, patch, message) => {
        expect(await failure(send({ ...foreign, ...patch }))).toMatchObject({
          status: 400,
          code: 'invalid-request',
          message,
        });
        expect(directOrders.create).not.toHaveBeenCalled();
      });

      it('should refuse a time in the future today', async () => {
        const tomorrow = new Date(Date.now() + 36 * 3_600_000).toISOString().slice(0, 10);

        expect(await failure(send({ ...foreign, date: tomorrow, time: '23:59' }))).toMatchObject({
          status: 400,
          message: 'Дата й час оплати не можуть бути в майбутньому.',
        });
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

  describe('paid', () => {
    it('should pass the manager, the id and the body to the completion service', async () => {
      const dto = { date: '2026-11-04', time: '14:30' };
      completion.markPaid.mockResolvedValue({ paidAt: '2026-11-04T12:30:00.000Z' });

      await expect(controller.paid(manager, 'req1', dto)).resolves.toEqual({
        paidAt: '2026-11-04T12:30:00.000Z',
      });
      expect(completion.markPaid).toHaveBeenCalledWith(manager, 'req1', dto);
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
      const answer = await edit({ comment: ' ', officialDocs: false });

      expect(finance.edit).toHaveBeenCalledWith('req1', {
        requesterTelegramId: 555,
        comment: null,
        officialDocs: false,
      });
      expect(sync.renderManager).toHaveBeenCalledWith(card, view);
      expect(sync.renderGroup).toHaveBeenCalledWith(card, view);
      expect(answer).toEqual({
        request: view,
        managerName: 'Уляна',
        completed: false,
        closed: false,
        payments: [],
      });
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

    it.each([['a bad sum', { sum: '1,5' }]])(
      'should answer 400, without calling finance, for %s',
      async (_, dto) => {
        const error = await failure(edit(dto));

        expect(error).toMatchObject({ status: 400, code: 'invalid-request' });
        expect(finance.edit).not.toHaveBeenCalled();
      },
    );

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
