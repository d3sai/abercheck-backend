import { Test } from '@nestjs/testing';
import { ApiError } from '../../../src/common/api-error';
import { PrismaService } from '../../../src/common/prisma/prisma.service';
import { type Manager, Prisma } from '../../../src/generated/prisma/client';
import { AttachmentsService } from '../../../src/modules/attachments/attachments.service';
import { DirectOrdersService } from '../../../src/modules/miniapp/direct-orders.service';
import { type OrderPlan } from '../../../src/modules/miniapp/miniapp.dto';
import { OrderNumberTakenError } from '../../../src/modules/orders/orders.errors';
import { OrdersService } from '../../../src/modules/orders/orders.service';
import { PaymentsService } from '../../../src/modules/payments/payments.service';
import { TelegramSender } from '../../../src/modules/telegram/core/telegram-sender';
import {
  CashDraftService,
  CashDraftStore,
} from '../../../src/modules/telegram/order-draft/cash-draft.service';
import { DraftAttachmentNotifier } from '../../../src/modules/telegram/order-draft/draft-attachment-notifier';
import {
  ForeignDraftService,
  ForeignDraftStore,
} from '../../../src/modules/telegram/order-draft/foreign-draft.service';
import {
  KitDraftService,
  KitDraftStore,
} from '../../../src/modules/telegram/order-draft/kit-draft.service';
import { PendingFilesStore } from '../../../src/modules/telegram/order-draft/pending-files.store';
import { ReportedPaymentService } from '../../../src/modules/telegram/order-draft/reported-payment.service';

const manager = { id: 7, telegramId: 5000000000n, name: 'Христина' } as Manager;
const paidAt = new Date('2026-01-15T12:30:00.000Z');
const dec = (value: string) => new Prisma.Decimal(value);
const stored = (orderNumber: string, currency = 'USD', status = 'AWAITING_PAYMENT') => ({
  order: { id: 1, orderNumber, currency, status },
  amountPaid: dec('0'),
});

const kit: OrderPlan = {
  kind: 'kit',
  plan: {
    accessCode: '647143353',
    total: dec('3176.71'),
    items: [
      { number: '0000-062265', amount: dec('2696.71') },
      { number: '0000-062937', amount: dec('480') },
    ],
    paidAt,
    comment: null,
    warnings: [],
  },
};
const cash: OrderPlan = {
  kind: 'cash',
  plan: {
    number: '0000-066498',
    amount: dec('4260'),
    currency: 'UAH',
    rate: '44.9',
    paidAt,
    handedBy: 'Христина Павлів',
    withPercent: true,
    comment: 'у конверті',
    warnings: [],
  },
};
const foreign: OrderPlan = {
  kind: 'foreign',
  plan: {
    number: '0000-066498',
    amount: dec('100'),
    currency: 'EUR',
    recipient: 'Абертайм ТОВ',
    rate: '44.9',
    paidAt,
    comment: null,
    warnings: [],
  },
};

const failure = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ApiError) {
      return {
        status: error.getStatus(),
        ...(error.getResponse() as { code: string; message: string }),
      };
    }
    throw error;
  }
  throw new Error('Expected a rejection');
};

describe('DirectOrdersService', () => {
  const orders = { findWithBalance: jest.fn(), createGroup: jest.fn(), setPaidAt: jest.fn() };
  const payments = { findByExternalId: jest.fn(), ingest: jest.fn() };
  const sender = {
    sendToAdmins: jest.fn(),
    send: jest.fn(),
    miniAppUrl: undefined as string | undefined,
  };
  let service: DirectOrdersService;

  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [
        DirectOrdersService,
        KitDraftService,
        KitDraftStore,
        CashDraftService,
        CashDraftStore,
        ForeignDraftService,
        ForeignDraftStore,
        ReportedPaymentService,
        PendingFilesStore,
        DraftAttachmentNotifier,
        { provide: OrdersService, useValue: orders },
        { provide: PaymentsService, useValue: payments },
        { provide: AttachmentsService, useValue: {} },
        { provide: TelegramSender, useValue: sender },
        { provide: PrismaService, useValue: {} },
      ],
    }).compile();
    service = moduleRef.get(DirectOrdersService);
    orders.findWithBalance.mockResolvedValue(null);
    orders.createGroup.mockResolvedValue([{ id: 1 }]);
    payments.findByExternalId.mockResolvedValue(null);
    payments.ingest.mockResolvedValue({ kind: 'recorded', order: { id: 1 } });
  });

  afterEach(() => jest.resetAllMocks());

  describe('kit', () => {
    it('should create the new numbers, skip the existing ones and tell the admins', async () => {
      orders.findWithBalance.mockImplementation((number: string) =>
        Promise.resolve(number === '0000-062937' ? stored(number) : null),
      );

      const result = await service.create(manager, kit);

      expect(result).toMatchObject({ orderNumbers: ['0000-062265'], skipped: ['0000-062937'] });
      expect(result.note).toContain('уже є в системі');

      expect(orders.createGroup).toHaveBeenCalledWith(
        manager.id,
        [{ orderNumber: '0000-062265', amountDue: '2696.71' }],
        expect.objectContaining({
          clientName: 'Оплата на Кит',
          currency: 'USD',
          paidAt,
          comment: 'Оплата на Кит · код доступу 647143353',
        }),
      );
      expect(payments.ingest).not.toHaveBeenCalled();
      expect(sender.sendToAdmins).toHaveBeenCalledWith(expect.stringContaining('647143353'));
    });

    it('should only tell the admins when every number exists', async () => {
      orders.findWithBalance.mockImplementation((number: string) =>
        Promise.resolve(stored(number)),
      );

      const result = await service.create(manager, kit);

      expect(result.orderNumbers).toEqual([]);
      expect(result.skipped).toEqual(['0000-062265', '0000-062937']);
      expect(orders.createGroup).not.toHaveBeenCalled();
      expect(sender.sendToAdmins).toHaveBeenCalledTimes(1);
    });

    it('should answer 409 when a number appears while the orders are created', async () => {
      orders.createGroup.mockRejectedValue(new OrderNumberTakenError('0000-062265'));

      const error = await failure(service.create(manager, kit));

      expect(error).toMatchObject({ status: 409, code: 'order-taken' });
      expect(error.message).toContain('Номер 0000-062265 щойно з');
      expect(sender.sendToAdmins).not.toHaveBeenCalled();
    });
  });

  describe('cash', () => {
    it('should create the order and record the payment without telling the admins', async () => {
      await expect(service.create(manager, cash)).resolves.toEqual({
        orderNumbers: ['0000-066498'],
        skipped: [],
      });

      expect(orders.createGroup).toHaveBeenCalledWith(
        manager.id,
        [{ orderNumber: '0000-066498', amountDue: '4260.00' }],
        expect.objectContaining({
          clientName: 'Оплата готівкою',
          currency: 'UAH',
          exchangeRate: '44.9',
          comment:
            'Оплата готівкою · Христина Павлів · курс 44,9 · з урахуванням %: так · у конверті',
        }),
      );
      expect(payments.ingest).toHaveBeenCalledWith(
        expect.objectContaining({
          external_transaction_id: 'cash:0000-066498:2026-01-15T12:30:00.000Z:4260.00',
          amount: '4260.00',
          currency: 'UAH',
          payer_name: 'Христина Павлів',
          receiving_account: 'Готівка',
        }),
      );
      expect(sender.sendToAdmins).not.toHaveBeenCalled();
    });

    it('should only record the payment on an existing number of the same currency', async () => {
      orders.findWithBalance.mockResolvedValue(stored('0000-066498', 'UAH'));

      const result = await service.create(manager, cash);

      expect(result).toMatchObject({ orderNumbers: [], skipped: ['0000-066498'] });
      expect(orders.createGroup).not.toHaveBeenCalled();
      expect(payments.ingest).toHaveBeenCalledTimes(1);
    });

    it('should answer 409 for a currency mismatch', async () => {
      orders.findWithBalance.mockResolvedValue(stored('0000-066498', 'USD'));

      expect(await failure(service.create(manager, cash))).toMatchObject({
        status: 409,
        code: 'order-conflict',
        message: '№ 0000-066498 у доларах, а оплата в гривнях.',
      });
      expect(payments.ingest).not.toHaveBeenCalled();
    });

    it('should answer 409 for a cancelled number', async () => {
      orders.findWithBalance.mockResolvedValue(stored('0000-066498', 'UAH', 'CANCELLED'));

      expect(await failure(service.create(manager, cash))).toMatchObject({
        status: 409,
        message: '№ 0000-066498 скасовано, оплату до нього не додати.',
      });
    });

    it('should answer 409 when the same payment is already recorded', async () => {
      payments.findByExternalId.mockResolvedValue({ id: 1 });

      expect(await failure(service.create(manager, cash))).toMatchObject({
        status: 409,
        code: 'already-recorded',
        message: 'Цю оплату вже зареєстровано.',
      });
      expect(orders.createGroup).not.toHaveBeenCalled();
    });

    it('should answer 409 when the number appears while the order is created', async () => {
      orders.createGroup.mockRejectedValue(new OrderNumberTakenError('0000-066498'));

      expect(await failure(service.create(manager, cash))).toMatchObject({
        status: 409,
        code: 'order-taken',
      });
      expect(payments.ingest).not.toHaveBeenCalled();
    });
  });

  describe('foreign', () => {
    it('should create the order in its currency, record no payment and tell the admins', async () => {
      await expect(service.create(manager, foreign)).resolves.toEqual({
        orderNumbers: ['0000-066498'],
        skipped: [],
      });

      expect(orders.createGroup).toHaveBeenCalledWith(
        manager.id,
        [{ orderNumber: '0000-066498', amountDue: '100.00' }],
        expect.objectContaining({
          clientName: 'Оплата закордонного замовлення',
          currency: 'EUR',
          exchangeRate: '44.9',
          comment: 'Оплата закордонного замовлення · на Абертайм ТОВ',
        }),
      );
      expect(payments.ingest).not.toHaveBeenCalled();
      expect(sender.sendToAdmins).toHaveBeenCalledWith(expect.stringContaining('Абертайм ТОВ'));
    });

    it('should write to the manager with «Оплачено» when the order has no date yet', async () => {
      sender.miniAppUrl = 'https://cab.example.ua/tg/request';
      const undated: OrderPlan = {
        kind: 'foreign',
        plan: { ...foreign.plan, paidAt: null },
      };

      await service.create(manager, undated);

      expect(sender.send).toHaveBeenCalledWith(
        manager.telegramId,
        expect.stringContaining('0000-066498'),
        [
          [
            {
              text: '💰 Оплачено',
              web_app: {
                url: 'https://cab.example.ua/tg/request?mode=orderpaid&id=0000-066498',
              },
            },
          ],
        ],
      );
    });

    it('should not write to the manager when the order has its date', async () => {
      sender.miniAppUrl = 'https://cab.example.ua/tg/request';

      await service.create(manager, foreign);

      expect(sender.send).not.toHaveBeenCalled();
    });

    it('should only tell the admins when the order exists', async () => {
      orders.findWithBalance.mockResolvedValue(stored('0000-066498', 'EUR'));

      const result = await service.create(manager, foreign);

      expect(result).toMatchObject({ orderNumbers: [], skipped: ['0000-066498'] });
      expect(orders.createGroup).not.toHaveBeenCalled();
      expect(sender.sendToAdmins).toHaveBeenCalledTimes(1);
    });

    it('should answer 409 when the number appears while the order is created', async () => {
      orders.createGroup.mockRejectedValue(new OrderNumberTakenError('0000-066498'));

      expect(await failure(service.create(manager, foreign))).toMatchObject({
        status: 409,
        code: 'order-taken',
      });
      expect(sender.sendToAdmins).not.toHaveBeenCalled();
    });
  });

  describe('«Оплачено» of an order without a request', () => {
    const own = {
      order: {
        id: 5,
        managerId: manager.id,
        orderNumber: '0000-066498',
        clientName: 'Оплата закордонного замовлення',
        amountDue: dec('100'),
        currency: 'EUR',
        paidAt: null,
      },
    };

    it("should show the manager's own order", async () => {
      orders.findWithBalance.mockResolvedValue(own);

      await expect(service.view(manager, '0000-066498')).resolves.toEqual({
        orderNumber: '0000-066498',
        clientName: 'Оплата закордонного замовлення',
        amount: '100.00',
        currency: 'EUR',
        paidAt: null,
      });
    });

    it('should stamp the date and time the client paid', async () => {
      orders.findWithBalance.mockResolvedValue(own);

      const result = await service.markPaid(manager, '0000-066498', {
        date: '2026-01-15',
        time: '14:30',
      });

      expect(orders.setPaidAt).toHaveBeenCalledWith([5], new Date('2026-01-15T12:30:00.000Z'));
      expect(result).toEqual({ paidAt: '2026-01-15T12:30:00.000Z' });
    });

    it.each([
      ["another manager's order", { order: { ...own.order, managerId: 99 } }],
      ['a missing order', null],
    ])('should answer 404 for %s', async (_, found) => {
      orders.findWithBalance.mockResolvedValue(found);

      expect(
        await failure(service.markPaid(manager, '0000-066498', { date: '2026-01-15' })),
      ).toMatchObject({ status: 404 });
      expect(orders.setPaidAt).not.toHaveBeenCalled();
    });
  });
});
