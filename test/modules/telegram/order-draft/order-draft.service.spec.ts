import { Test } from '@nestjs/testing';
import { PrismaService } from '../../../../src/common/prisma/prisma.service';
import { type Manager, Prisma } from '../../../../src/generated/prisma/client';
import { AttachmentsService } from '../../../../src/modules/attachments/attachments.service';
import { OrdersService } from '../../../../src/modules/orders/orders.service';
import { PaymentsService } from '../../../../src/modules/payments/payments.service';
import { RequisitesService } from '../../../../src/modules/requisites/requisites.service';
import { TelegramSender } from '../../../../src/modules/telegram/core/telegram-sender';
import {
  CashDraftService,
  CashDraftStore,
} from '../../../../src/modules/telegram/order-draft/cash-draft.service';
import { ReportedPaymentService } from '../../../../src/modules/telegram/order-draft/reported-payment.service';
import { DraftAttachmentNotifier } from '../../../../src/modules/telegram/order-draft/draft-attachment-notifier';
import {
  ForeignDraftService,
  ForeignDraftStore,
} from '../../../../src/modules/telegram/order-draft/foreign-draft.service';
import {
  KitDraftService,
  KitDraftStore,
} from '../../../../src/modules/telegram/order-draft/kit-draft.service';
import { OrderDraftService } from '../../../../src/modules/telegram/order-draft/order-draft.service';
import { PendingFilesStore } from '../../../../src/modules/telegram/order-draft/pending-files.store';

describe('OrderDraftService', () => {
  const USER = 5000000000n;
  const MANAGER: Manager = {
    id: 7,
    telegramId: USER,
    name: 'Христина',
    username: 'khrystyna',
    status: 'ACTIVE',
    role: 'MANAGER',
    login: null,
    passwordHash: null,
    sessionVersion: 0,
    createdAt: new Date(),
  };
  const orders = {
    findWithBalance: jest.fn(),
    create: jest.fn(),
    createGroup: jest.fn(),
  };
  const requisites = { addMany: jest.fn(), list: jest.fn() };
  const payments = { findByExternalId: jest.fn(), ingest: jest.fn() };
  const attachments = { saveFromTelegram: jest.fn() };
  const sender = { sendToAdmins: jest.fn(), send: jest.fn() };
  let service: OrderDraftService;

  const file = (filename = 'screenshot.png') => ({
    fileId: 'file-1',
    filename,
    mimeType: 'image/png',
    size: 1024,
    kind: 'document' as const,
  });

  const createdOrder = (overrides: Partial<Record<string, unknown>> = {}) => ({
    id: 1,
    orderNumber: '0000-066717',
    baseNumber: '0000-066717',
    clientName: 'Чернявський Владислав',
    amountDue: new Prisma.Decimal('6158.41'),
    currency: 'UAH',
    exchangeRate: new Prisma.Decimal('44.9'),
    comment: 'Терміново',
    orderType: 'REGULAR',
    status: 'AWAITING_PAYMENT',
    managerId: MANAGER.id,
    createdAt: new Date('2026-09-18T20:41:00Z'),
    updatedAt: new Date('2026-09-18T20:41:00Z'),
    ...overrides,
  });

  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [
        OrderDraftService,
        PendingFilesStore,
        KitDraftService,
        KitDraftStore,
        CashDraftService,
        CashDraftStore,
        ForeignDraftService,
        ForeignDraftStore,
        ReportedPaymentService,
        DraftAttachmentNotifier,
        { provide: OrdersService, useValue: orders },
        { provide: RequisitesService, useValue: requisites },
        { provide: PaymentsService, useValue: payments },
        { provide: AttachmentsService, useValue: attachments },
        { provide: TelegramSender, useValue: sender },
        { provide: PrismaService, useValue: { order: { update: jest.fn() } } },
      ],
    }).compile();

    service = moduleRef.get(OrderDraftService);
    orders.findWithBalance.mockResolvedValue(null);
    requisites.list.mockResolvedValue([]);
    requisites.addMany.mockResolvedValue([]);
  });

  afterEach(() => jest.resetAllMocks());

  it('should ignore plain text outside an armed mode', async () => {
    expect(await service.handleText(MANAGER, 'просто текст')).toBeNull();
    expect(orders.create).not.toHaveBeenCalled();
  });

  it('should drop buffered files on cancel', async () => {
    service.startKit(USER);
    await service.addFile(MANAGER, file());

    expect(service.cancel(USER).html).toContain('Скасовано');

    service.startKit(USER);
    expect((await service.addFile(MANAGER, file()))?.html).toContain('1/10');
  });

  it('should say there is nothing to cancel otherwise', () => {
    expect(service.cancel(USER).html).toContain('Нема чого');
  });

  describe('attaching a file', () => {
    beforeEach(() => {
      service.startKit(USER);
    });

    it('should not store a file outside an armed mode', async () => {
      service.cancel(USER);

      expect(await service.addFile(MANAGER, file())).toBeNull();
      expect(service.cancel(USER).html).toContain('Нема чого');
    });

    it('should just acknowledge a standalone file with no caption', async () => {
      const reply = await service.addFile(MANAGER, file());

      expect(reply?.html).toContain('Додано');
      expect(reply?.html).toContain('1/10');
    });

    it('should reject an unsupported file type', async () => {
      const reply = await service.addFile(MANAGER, { ...file(), mimeType: 'application/zip' });

      expect(reply?.html).toContain('не підтримується');
    });

    it('should cap the number of buffered files', async () => {
      for (let i = 0; i < 10; i += 1) {
        await service.addFile(MANAGER, file(`f${i}.png`));
      }

      const reply = await service.addFile(MANAGER, file('overflow.png'));

      expect(reply?.html).toContain('Максимум 10');
    });

    it('should hand a caption to the armed mode', async () => {
      const reply = await service.addFile(MANAGER, file(), 'це не схоже на повідомлення про Кит');

      expect(reply?.html).toContain('Потрібно виправити');
    });
  });

  describe('a transfer to Кит, armed by /kit', () => {
    const EXAMPLE = `Оплата на Кит
Код доступу : 647143353
Загальна сума : 3500 дол
0000-062265 2 696,71 дол
0000-062937 480,00 дол
залишок 323,29 дол внести в це замволення 0000-065651
Дата та час : 21.08.2026 14:44`;
    const existing = (status = 'PARTIALLY_PAID', currency = 'USD') => ({
      order: createdOrder({ orderNumber: '0000-065651', status, currency }),
      amountPaid: new Prisma.Decimal(0),
    });

    const begin = async (text = EXAMPLE) => {
      service.startKit(USER);
      return service.handleText(MANAGER, text);
    };

    beforeEach(() => {
      orders.findWithBalance.mockImplementation((number: string) =>
        Promise.resolve(number === '0000-065651' ? existing() : null),
      );
    });

    it('should create only the new numbers, unpaid, and record no payment', async () => {
      orders.createGroup.mockResolvedValue([
        createdOrder({ orderNumber: '0000-062265' }),
        createdOrder({ orderNumber: '0000-062937' }),
      ]);

      const preview = await begin();
      expect(preview?.html).toContain('0000-065651</b> — 323,29 $ (уже є в системі)');
      expect(preview?.html).toContain('Створю нові номери');

      const reply = await service.confirmKit(MANAGER);

      expect(orders.createGroup).toHaveBeenCalledWith(
        MANAGER.id,
        [
          { orderNumber: '0000-062265', amountDue: '2696.71' },
          { orderNumber: '0000-062937', amountDue: '480.00' },
        ],
        expect.objectContaining({
          currency: 'USD',
          comment: 'Оплата на Кит · код доступу 647143353',
        }),
      );
      expect(payments.ingest).not.toHaveBeenCalled();
      expect(sender.sendToAdmins).toHaveBeenCalledWith(expect.stringContaining('647143353'));
      expect(reply.html).toContain('«Оплата на Кит» надіслано адмінам · 3 500 $');
      expect(reply.html).toContain('Нових номерів: 2');
    });

    it('should only tell the admins when every number already exists', async () => {
      orders.findWithBalance.mockResolvedValue(existing());

      expect((await begin())?.html).toContain('Усі номери вже є в системі');
      const reply = await service.confirmKit(MANAGER);

      expect(orders.createGroup).not.toHaveBeenCalled();
      expect(sender.sendToAdmins).toHaveBeenCalledTimes(1);
      expect(reply.html).not.toContain('Нових номерів');
    });
  });

  describe('cash, armed by /cash', () => {
    const SAMPLE = `0000-066498
01.09.2026 15:20
4260 грн
44,9
Христина Павлів передала готівку Христині Вихопень ( Саджениці)`;

    const begin = async (text = SAMPLE) => {
      service.startCash(USER);
      return service.handleText(MANAGER, text);
    };

    beforeEach(() => {
      payments.findByExternalId.mockResolvedValue(null);
      payments.ingest.mockResolvedValue({ kind: 'recorded', order: createdOrder() });
    });

    it('should create a new number and record the cash on it', async () => {
      orders.createGroup.mockResolvedValue([createdOrder({ orderNumber: '0000-066498' })]);

      const preview = await begin();
      expect(preview?.html).toContain('Створю це замовлення');

      const reply = await service.confirmCash(MANAGER);

      expect(orders.createGroup).toHaveBeenCalledWith(
        MANAGER.id,
        [{ orderNumber: '0000-066498', amountDue: '4260.00' }],
        expect.objectContaining({
          clientName: 'Оплата готівкою',
          currency: 'UAH',
          exchangeRate: '44.9',
        }),
      );
      expect(payments.ingest).toHaveBeenCalledWith(
        expect.objectContaining({
          external_transaction_id: 'cash:0000-066498:2026-09-01T12:20:00.000Z:4260.00',
          order_number: '0000-066498',
          amount: '4260.00',
          currency: 'UAH',
          payer_name: 'Христина Павлів передала готівку Христині Вихопень ( Саджениці)',
        }),
      );
      expect(reply.html).toContain('Оплату готівкою записано');
    });

    it('should only record dollars on an existing dollar number', async () => {
      orders.findWithBalance.mockResolvedValue({
        order: createdOrder({ orderNumber: '0000-066498', currency: 'USD' }),
        amountPaid: new Prisma.Decimal(0),
      });

      expect((await begin('0000-066498\n150 $\n01.09.2026 15:20'))?.html).toContain(
        '(уже є в системі)',
      );
      await service.confirmCash(MANAGER);

      expect(orders.createGroup).not.toHaveBeenCalled();
      expect(payments.ingest).toHaveBeenCalledWith(
        expect.objectContaining({ amount: '150.00', currency: 'USD' }),
      );
    });

    it('should refuse hryvnias on a dollar number, and the same cash twice', async () => {
      orders.findWithBalance.mockResolvedValue({
        order: createdOrder({ orderNumber: '0000-066498', currency: 'USD' }),
        amountPaid: new Prisma.Decimal(0),
      });
      expect((await begin())?.html).toContain('у доларах, а оплата в гривнях');

      payments.findByExternalId.mockResolvedValue({ id: 1 });
      expect((await begin())?.html).toContain('Цю оплату вже зареєстровано');
    });

    it('should name a euro number in the currency mismatch', async () => {
      orders.findWithBalance.mockResolvedValue({
        order: createdOrder({ orderNumber: '0000-066498', currency: 'EUR' }),
        amountPaid: new Prisma.Decimal(0),
      });

      expect((await begin())?.html).toContain('у євро, а оплата в гривнях');
    });
  });

  describe('a foreign order payment, armed by /foreign', () => {
    const TEMPLATE = `🌍 Оплата закордонного замовлення
На кого : Абертайм ТОВ ( EUR)
№ 0000-066498
💰 Сума: 100 EUR
💱 Валюта: EUR
Дата : 13.10.2026 15:20
Курс : 44,9
Коментар: інвойс 17`;

    const begin = async (text = TEMPLATE) => {
      service.startForeign(USER);
      return service.handleText(MANAGER, text);
    };

    it('should create the euro order unpaid and record no payment', async () => {
      orders.createGroup.mockResolvedValue([
        createdOrder({ orderNumber: '0000-066498', currency: 'EUR' }),
      ]);

      const preview = await begin();
      expect(preview?.html).toContain('Сума: <b>100 €</b>');
      expect(preview?.html).toContain('Оплату не записую');

      const reply = await service.confirmForeign(MANAGER);

      expect(orders.createGroup).toHaveBeenCalledWith(
        MANAGER.id,
        [{ orderNumber: '0000-066498', amountDue: '100.00' }],
        expect.objectContaining({
          clientName: 'Оплата закордонного замовлення',
          currency: 'EUR',
          exchangeRate: '44.9',
          comment: 'Оплата закордонного замовлення · на Абертайм ТОВ ( EUR) · інвойс 17',
        }),
      );
      expect(payments.ingest).not.toHaveBeenCalled();
      expect(sender.sendToAdmins).toHaveBeenCalledWith(expect.stringContaining('0000-066498'));
      expect(reply.html).toContain('«Оплата закордонного замовлення» надіслано адмінам · 100 €');
    });

    it('should only tell the admins when the number already exists', async () => {
      orders.findWithBalance.mockResolvedValue({
        order: createdOrder({ orderNumber: '0000-066498', currency: 'EUR' }),
        amountPaid: new Prisma.Decimal(0),
      });

      expect((await begin())?.html).toContain('(уже є в системі)');
      await service.confirmForeign(MANAGER);

      expect(orders.createGroup).not.toHaveBeenCalled();
      expect(sender.sendToAdmins).toHaveBeenCalledTimes(1);
    });

    it('should ignore the template outside the armed mode', async () => {
      expect(await service.handleText(MANAGER, TEMPLATE)).toBeNull();
      expect(await service.addFile(MANAGER, file(), TEMPLATE)).toBeNull();
      expect(orders.create).not.toHaveBeenCalled();
      expect(orders.createGroup).not.toHaveBeenCalled();
    });

    it('should create the order in the currency the template names', async () => {
      orders.createGroup.mockResolvedValue([
        createdOrder({ orderNumber: '0000-066498', currency: 'USD' }),
      ]);

      const dollars = TEMPLATE.replace('100 EUR', '150 $').replace('Валюта: EUR', 'Валюта: USD');
      expect((await begin(dollars))?.html).toContain('Сума: <b>150 $</b>');
      await service.confirmForeign(MANAGER);

      expect(orders.createGroup).toHaveBeenCalledWith(
        MANAGER.id,
        [{ orderNumber: '0000-066498', amountDue: '150.00' }],
        expect.objectContaining({ currency: 'USD' }),
      );
    });

    it('should refuse clashing currencies and a missing time instead of creating the order', async () => {
      expect((await begin(TEMPLATE.replace('100 EUR', '100 грн')))?.html).toContain('різні валюти');
      expect((await begin(TEMPLATE.replace('15:20', '')))?.html).toContain('Не вказано дату й час');
      expect(orders.createGroup).not.toHaveBeenCalled();
    });
  });

  describe('onApplicationShutdown', () => {
    it('should warn a manager with buffered files', async () => {
      service.startKit(USER);
      await service.addFile(MANAGER, file());

      await service.onApplicationShutdown();

      expect(sender.send).toHaveBeenCalledWith(
        MANAGER.telegramId,
        expect.stringContaining('перезапускається'),
      );
    });

    it('should warn a manager who armed a mode', async () => {
      service.startCash(USER);

      await service.onApplicationShutdown();

      expect(sender.send).toHaveBeenCalledWith(USER, expect.any(String));
    });

    it('should warn each affected manager only once, and leave others alone', async () => {
      service.startKit(USER);
      await service.addFile(MANAGER, file());
      const other = { ...MANAGER, id: 8, telegramId: 6000000000n };

      await service.onApplicationShutdown();

      expect(sender.send).toHaveBeenCalledTimes(1);
      expect(sender.send).not.toHaveBeenCalledWith(other.telegramId, expect.any(String));
    });

    it('should not warn anyone when nothing is pending', async () => {
      await service.onApplicationShutdown();

      expect(sender.send).not.toHaveBeenCalled();
    });
  });
});
