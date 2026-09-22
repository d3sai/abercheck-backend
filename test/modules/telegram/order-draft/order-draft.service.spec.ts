import { Test } from '@nestjs/testing';
import { type Manager, OrderType, Prisma } from '../../../../src/generated/prisma/client';
import { AttachmentsService } from '../../../../src/modules/attachments/attachments.service';
import { OrderNumberTakenError } from '../../../../src/modules/orders/orders.errors';
import { OrdersService } from '../../../../src/modules/orders/orders.service';
import { RequisitesService } from '../../../../src/modules/requisites/requisites.service';
import { TelegramSender } from '../../../../src/modules/telegram/core/telegram-sender';
import {
  DraftAction,
  OrderDraftService,
} from '../../../../src/modules/telegram/order-draft/order-draft.service';

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
    exchangeRate: new Prisma.Decimal('44.9'),
    comment: 'Терміново',
    orderType: 'REGULAR',
    status: 'AWAITING_PAYMENT',
    managerId: MANAGER.id,
    createdAt: new Date('2026-09-18T20:41:00Z'),
    updatedAt: new Date('2026-09-18T20:41:00Z'),
    ...overrides,
  });

  const template = (overrides: Partial<Record<string, string>> = {}): string => {
    const fields = {
      Номер: '0000-066717',
      ФОП: 'Чернявський Владислав',
      Сума: '6 158,41',
      Курс: '44,9',
      Коментар: 'Терміново',
      ...overrides,
    };
    return Object.entries(fields)
      .map(([label, value]) => `${label}: ${value}`)
      .join('\n');
  };

  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [
        OrderDraftService,
        { provide: OrdersService, useValue: orders },
        { provide: RequisitesService, useValue: requisites },
        { provide: AttachmentsService, useValue: attachments },
        { provide: TelegramSender, useValue: sender },
      ],
    }).compile();

    service = moduleRef.get(OrderDraftService);
    orders.findWithBalance.mockResolvedValue(null);
    requisites.list.mockResolvedValue([]);
    requisites.addMany.mockResolvedValue([]);
  });

  afterEach(() => jest.resetAllMocks());

  it('should star the number, name and amount in the regular hint', () => {
    const reply = service.hint(OrderType.REGULAR);

    expect(reply.html).toContain(
      "Порядок рядків (* — обов'язкове):\nНомер*, ФОП*, Сума*, Курс, Коментар\n",
    );
    expect(reply.html).toContain('0000-066717');
    expect(reply.buttons).toBeUndefined();
  });

  it('should star only the name and amount in the minus-closing hint', () => {
    const reply = service.hint(OrderType.MINUS_CLOSING);

    expect(reply.html).toContain(
      "Порядок рядків (* — обов'язкове):\nФОП*, Сума*, Курс, Коментар\n",
    );
    expect(reply.html).not.toContain('Номер');
    expect(reply.html).not.toContain('0000-066717');
    expect(reply.html).toContain('Закриття мінусу');
  });

  it('should tell managers what happens when the number is already taken, but not for a minus', () => {
    expect(service.hint(OrderType.REGULAR).html).toContain('додати ще одну частину');
    expect(service.hint(OrderType.MINUS_CLOSING).html).not.toContain('частину');
  });

  it('should never label anything as optional', () => {
    const html = [OrderType.REGULAR, OrderType.MINUS_CLOSING].map((t) => service.hint(t).html);

    expect(html.join('\n')).not.toMatch(/необов/i);
  });

  it('should ignore plain chat text with no recognizable fields', async () => {
    await expect(service.handleText(MANAGER, 'привіт, як справи?')).resolves.toBeNull();
  });

  it('should list every validation error without creating an order', async () => {
    const reply = await service.handleText(
      MANAGER,
      template({ Номер: '1548', ФОП: '', Сума: 'сто' }),
    );

    expect(reply?.html).toContain('«Номер»');
    expect(reply?.html).toContain('«ФОП» — поле');
    expect(reply?.html).toContain('«Сума»');
    expect(orders.create).not.toHaveBeenCalled();
  });

  describe('refusing several numbers / requisites outside the button, with guidance', () => {
    it('should refuse a message with more than one order number', async () => {
      const reply = await service.handleText(
        MANAGER,
        '0000-068772 335,58 грн.\n0000-068773 971,83 грн.\n44,9%',
      );

      expect(reply?.html).toContain('кілька номерів або оплату на чужі реквізити');
      expect(reply?.html).toContain('💳 Кілька номерів / реквізити');
      expect(reply?.html).toContain('/requisites');
      expect(orders.create).not.toHaveBeenCalled();
    });

    it('should refuse a message that mentions a card, even with just one number', async () => {
      const reply = await service.handleText(
        MANAGER,
        '0000-066092\nФОП Носенко Роман\n4441 1110 6964 5962 картка для довідки\n4 527,00 грн',
      );

      expect(reply?.html).toContain('кілька номерів або оплату на чужі реквізити');
      expect(orders.create).not.toHaveBeenCalled();
    });

    it('should refuse a message that mentions an IBAN or a ЄДРПОУ/IBAN marker word, with no number at all', async () => {
      const withIban = await service.handleText(
        MANAGER,
        'Закрила Любов Андрейчук\nUA549358710000067320000088286\n4 890,00 грн',
      );
      const withMarker = await service.handleText(
        MANAGER,
        'Закрила Любов Андрейчук\nЄДРПОУ 12345678\n4 890,00 грн',
      );

      expect(withIban?.html).toContain('кілька номерів або оплату на чужі реквізити');
      expect(withMarker?.html).toContain('кілька номерів або оплату на чужі реквізити');
      expect(orders.create).not.toHaveBeenCalled();
    });

    it('should still work through /requisites once guided there', async () => {
      const guided = await service.handleText(
        MANAGER,
        '0000-068772 335,58 грн.\n0000-068773 971,83 грн.\n44,9%',
      );
      expect(guided?.html).toContain('/requisites');

      service.startRequisites(USER);
      orders.createGroup.mockResolvedValue([
        createdOrder({ id: 1, orderNumber: '0000-068772', baseNumber: '0000-068772' }),
        createdOrder({ id: 2, orderNumber: '0000-068773', baseNumber: '0000-068772' }),
      ]);
      const preview = await service.handleText(
        MANAGER,
        '0000-068772 335,58 грн.\n0000-068773 971,83 грн.\n44,9%',
      );

      expect(preview?.html).toContain('кілька номерів однією оплатою');
    });

    it('should leave the labelled classic template alone even if a field value looks like a card', async () => {
      orders.create.mockResolvedValue(createdOrder({ comment: 'картка 4441 1110 6964 5962' }));

      const reply = await service.handleText(
        MANAGER,
        template({ Коментар: 'картка 4441 1110 6964 5962' }),
      );

      expect(reply?.html).toContain('створено');
      expect(orders.create).toHaveBeenCalledWith(
        MANAGER.id,
        expect.objectContaining({ comment: 'картка 4441 1110 6964 5962' }),
        { notify: true, addPart: false },
      );
    });

    it('should leave a normal single-number classic order alone', async () => {
      orders.create.mockResolvedValue(createdOrder());

      const reply = await service.handleText(
        MANAGER,
        ['0000-066717', 'Чернявський Владислав', '6 158,41 грн'].join('\n'),
      );

      expect(reply?.html).toContain('створено');
      expect(orders.create).toHaveBeenCalled();
    });

    it('should leave a normal minus-closing template alone', async () => {
      orders.create.mockResolvedValue(createdOrder({ orderType: 'MINUS_CLOSING' }));

      const reply = await service.handleText(
        MANAGER,
        ['Чернявський Владислав', '6 158,41 грн'].join('\n'),
      );

      expect(reply?.html).toContain('створено');
      expect(orders.create).toHaveBeenCalledWith(
        MANAGER.id,
        expect.objectContaining({ orderType: 'MINUS_CLOSING' }),
        { notify: true, addPart: false },
      );
    });
  });

  describe('a number that already exists', () => {
    const existing = {
      order: {
        orderNumber: '0000-066717',
        clientName: 'Чернявський Владислав',
        amountDue: new Prisma.Decimal('6158.41'),
      },
      amountPaid: new Prisma.Decimal('1000'),
    };
    const partOfNumber = () =>
      createdOrder({ id: 2, orderNumber: '0000-066717(1)', baseNumber: '0000-066717' });

    beforeEach(() => orders.findWithBalance.mockResolvedValue(existing));

    it('should not create a duplicate, but offer to add a part', async () => {
      const reply = await service.handleText(MANAGER, template());

      expect(orders.findWithBalance).toHaveBeenCalledWith('0000-066717');
      expect(reply?.html).toContain('вже є в системі');
      expect(reply?.html).toContain('Чернявський Владислав');
      expect(reply?.html).toContain('ще однією частиною');
      expect(
        reply?.buttons?.flat().map((b) => ('callback_data' in b ? b.callback_data : null)),
      ).toEqual([DraftAction.AddPart, DraftAction.SkipPart]);
      expect(orders.create).not.toHaveBeenCalled();
    });

    it('should add the part with the remembered data once the manager confirms', async () => {
      orders.create.mockResolvedValue(partOfNumber());
      await service.handleText(MANAGER, template({ ФОП: 'Другий ФОП', Сума: '1 000' }));

      const reply = await service.addPart(MANAGER);

      expect(orders.create).toHaveBeenCalledWith(
        MANAGER.id,
        expect.objectContaining({
          orderNumber: '0000-066717',
          clientName: 'Другий ФОП',
          amountDue: '1000',
        }),
        { notify: true, addPart: true },
      );
      expect(reply.html).toContain('Частину замовлення');
      expect(reply.html).toContain('0000-066717(1)');
    });

    it('should keep the attached files for the part', async () => {
      orders.create.mockResolvedValue(partOfNumber());
      await service.addFile(MANAGER, file());
      await service.handleText(MANAGER, template());

      await service.addPart(MANAGER);

      expect(orders.create).toHaveBeenCalledWith(MANAGER.id, expect.anything(), {
        notify: false,
        addPart: true,
      });
      expect(attachments.saveFromTelegram).toHaveBeenCalledWith(
        expect.objectContaining({ orderNumber: '0000-066717(1)' }),
        [file()],
        { telegramId: MANAGER.telegramId, name: MANAGER.name },
        true,
        expect.stringContaining('Нова частина замовлення'),
      );
    });

    it('should add a part only once, however many times the button is pressed', async () => {
      orders.create.mockResolvedValue(partOfNumber());
      await service.handleText(MANAGER, template());

      await service.addPart(MANAGER);
      const again = await service.addPart(MANAGER);

      expect(orders.create).toHaveBeenCalledTimes(1);
      expect(again.html).toContain('Немає даних');
    });

    it('should forget the data when the manager declines', async () => {
      await service.handleText(MANAGER, template());

      expect(service.skipPart(USER).html).toContain('Скасовано');
      expect((await service.addPart(MANAGER)).html).toContain('Немає даних');
      expect(orders.create).not.toHaveBeenCalled();
    });

    it('should forget the data on /cancel', async () => {
      await service.handleText(MANAGER, template());

      expect(service.cancel(USER).html).toContain('Скасовано');
      expect((await service.addPart(MANAGER)).html).toContain('Немає даних');
    });

    it('should not add a part once the offer has expired', async () => {
      const now = jest.spyOn(Date, 'now');
      now.mockReturnValue(1_000_000);
      await service.handleText(MANAGER, template());

      now.mockReturnValue(1_000_000 + 11 * 60_000);
      const reply = await service.addPart(MANAGER);

      expect(reply.html).toContain('Немає даних');
      expect(orders.create).not.toHaveBeenCalled();
      now.mockRestore();
    });

    it('should not mix up the data of different managers', async () => {
      const other = { ...MANAGER, id: 8, telegramId: 6000000000n };
      orders.create.mockResolvedValue(partOfNumber());
      await service.handleText(MANAGER, template({ ФОП: 'Перший' }));

      expect((await service.addPart(other)).html).toContain('Немає даних');
      await service.addPart(MANAGER);

      expect(orders.create).toHaveBeenCalledWith(
        MANAGER.id,
        expect.objectContaining({ clientName: 'Перший' }),
        expect.anything(),
      );
    });

    it('should not ask anything for a closing minus, which has no number', async () => {
      orders.create.mockResolvedValue(createdOrder({ orderType: 'MINUS_CLOSING' }));

      await service.handleText(MANAGER, template({ Номер: '' }));

      expect(orders.findWithBalance).not.toHaveBeenCalled();
      expect(orders.create).toHaveBeenCalled();
    });
  });

  it('should create the order immediately once the message is complete', async () => {
    orders.create.mockResolvedValue(createdOrder());

    const reply = await service.handleText(MANAGER, template());

    expect(orders.create).toHaveBeenCalledWith(
      MANAGER.id,
      {
        orderType: 'REGULAR',
        orderNumber: '0000-066717',
        clientName: 'Чернявський Владислав',
        amountDue: '6158.41',
        exchangeRate: '44.9',
        comment: 'Терміново',
      },
      { notify: true, addPart: false },
    );
    expect(reply?.html).toContain('створено');
    expect(reply?.html).toContain('6 158,41');
  });

  it('should treat a missing order number as a minus-closing order', async () => {
    orders.create.mockResolvedValue(
      createdOrder({ orderNumber: '9999-000001', orderType: 'MINUS_CLOSING' }),
    );

    const reply = await service.handleText(MANAGER, template({ Номер: '' }));

    expect(orders.create).toHaveBeenCalledWith(
      MANAGER.id,
      expect.objectContaining({ orderType: 'MINUS_CLOSING' }),
      { notify: true, addPart: false },
    );
    expect(reply?.html).toContain('Закриття мінусу');
  });

  describe('freeform, line-per-field messages', () => {
    it('should create the order from unlabelled lines, like the old bot', async () => {
      orders.create.mockResolvedValue(createdOrder());

      const reply = await service.handleText(
        MANAGER,
        ['0000-066717', 'Чернявський Владислав', '6 158,41 грн', '44,9', 'Терміново'].join('\n'),
      );

      expect(orders.create).toHaveBeenCalledWith(
        MANAGER.id,
        {
          orderType: 'REGULAR',
          orderNumber: '0000-066717',
          clientName: 'Чернявський Владислав',
          amountDue: '6158.41',
          exchangeRate: '44.9',
          comment: 'Терміново',
        },
        { notify: true, addPart: false },
      );
      expect(reply?.html).toContain('створено');
    });

    it('should treat a missing first line as a minus-closing order', async () => {
      orders.create.mockResolvedValue(
        createdOrder({ orderNumber: '9999-000001', orderType: 'MINUS_CLOSING' }),
      );

      const reply = await service.handleText(
        MANAGER,
        ['Чернявський Владислав', '6 158,41 грн'].join('\n'),
      );

      expect(orders.create).toHaveBeenCalledWith(
        MANAGER.id,
        expect.objectContaining({ orderType: 'MINUS_CLOSING' }),
        { notify: true, addPart: false },
      );
      expect(reply?.html).toContain('Закриття мінусу');
    });

    it('should surface a validation error for a malformed order number line', async () => {
      const reply = await service.handleText(
        MANAGER,
        ['1234-5678', 'Чернявський Владислав', '6158,41 грн'].join('\n'),
      );

      expect(reply?.html).toContain('«Номер»');
      expect(orders.create).not.toHaveBeenCalled();
    });
  });

  it('should report a number taken between the check and the creation, keeping files buffered', async () => {
    orders.create.mockRejectedValue(new OrderNumberTakenError('0000-066717'));

    await service.addFile(MANAGER, file());
    const reply = await service.handleText(MANAGER, template());

    expect(reply?.html).toContain('вже є в системі');

    orders.create.mockResolvedValue(createdOrder());
    const retry = await service.handleText(MANAGER, template());
    expect(attachments.saveFromTelegram).toHaveBeenCalledWith(
      expect.anything(),
      [file()],
      { telegramId: MANAGER.telegramId, name: MANAGER.name },
      true,
      expect.any(String),
    );
    expect(retry?.html).toContain('створено');
  });

  it('should drop buffered files on cancel', async () => {
    await service.addFile(MANAGER, file());

    expect(service.cancel(USER).html).toContain('Скасовано');

    orders.create.mockResolvedValue(createdOrder());
    await service.handleText(MANAGER, template());
    expect(attachments.saveFromTelegram).not.toHaveBeenCalled();
  });

  it('should say there is nothing to cancel otherwise', () => {
    expect(service.cancel(USER).html).toContain('Нема чого');
  });

  describe('attaching a file', () => {
    it('should just acknowledge a standalone file with no caption', async () => {
      const reply = await service.addFile(MANAGER, file());

      expect(reply.html).toContain('Додано');
      expect(reply.html).toContain('1/10');
    });

    it('should create the order from a caption sent together with the file', async () => {
      orders.create.mockResolvedValue(createdOrder());

      const reply = await service.addFile(MANAGER, file(), template());

      expect(reply.html).toContain('створено');
      expect(attachments.saveFromTelegram).toHaveBeenCalledWith(
        expect.anything(),
        [file()],
        { telegramId: MANAGER.telegramId, name: MANAGER.name },
        true,
        expect.stringContaining('Нове замовлення'),
      );
    });

    it('should reject an unsupported file type', async () => {
      const reply = await service.addFile(MANAGER, { ...file(), mimeType: 'application/zip' });

      expect(reply.html).toContain('не підтримується');
    });

    it('should cap the number of buffered files', async () => {
      for (let i = 0; i < 10; i += 1) {
        await service.addFile(MANAGER, file(`f${i}.png`));
      }

      const reply = await service.addFile(MANAGER, file('overflow.png'));

      expect(reply.html).toContain('Максимум 10');
    });

    it('should nudge instead of the generic fallback when files are waiting for details', async () => {
      await service.addFile(MANAGER, file());

      const reply = await service.handleText(MANAGER, 'ще не знаю що писати');

      expect(reply?.html).toContain('без даних замовлення');
    });

    it('should notify admins with a single message merging the order and the file', async () => {
      const order = createdOrder();
      orders.create.mockResolvedValue(order);

      await service.addFile(MANAGER, file(), template());

      expect(orders.create).toHaveBeenCalledWith(MANAGER.id, expect.anything(), {
        notify: false,
        addPart: false,
      });
      expect(attachments.saveFromTelegram).toHaveBeenCalledWith(
        order,
        [file()],
        { telegramId: MANAGER.telegramId, name: MANAGER.name },
        true,
        expect.stringContaining('Нове замовлення'),
      );
      expect(sender.sendToAdmins).not.toHaveBeenCalled();
    });

    it('should fall back to a separate admin message when the merged caption would be too long', async () => {
      const longComment = 'Дуже '.repeat(200).trim();
      const order = createdOrder({ comment: longComment });
      orders.create.mockResolvedValue(order);

      await service.addFile(MANAGER, file(), template({ Коментар: longComment }));

      expect(attachments.saveFromTelegram).toHaveBeenCalledWith(
        order,
        [file()],
        { telegramId: MANAGER.telegramId, name: MANAGER.name },
        true,
        undefined,
      );
      expect(sender.sendToAdmins).toHaveBeenCalledWith(expect.stringContaining('Нове замовлення'));
    });

    it('should treat a file sent after a created order as the start of the next order', async () => {
      orders.create.mockResolvedValue(createdOrder());
      await service.handleText(MANAGER, template());

      const reply = await service.addFile(MANAGER, file('after.png'));

      expect(reply.html).toContain('Додано');
      expect(reply.html).toContain('1/10');
      expect(attachments.saveFromTelegram).not.toHaveBeenCalled();

      orders.create.mockResolvedValue(
        createdOrder({ id: 2, orderNumber: '0000-066718', baseNumber: '0000-066718' }),
      );
      await service.handleText(MANAGER, template({ Номер: '0000-066718' }));

      expect(attachments.saveFromTelegram).toHaveBeenCalledWith(
        expect.objectContaining({ orderNumber: '0000-066718' }),
        [file('after.png')],
        { telegramId: MANAGER.telegramId, name: MANAGER.name },
        true,
        expect.any(String),
      );
    });
  });

  describe('one message: "кілька номерів / реквізити", armed by /requisites', () => {
    const GROUP = `0000-068772 335,58 грн.
0000-068773 971,83 грн.
0000-068774 605,41 грн.
Загальна сума: 1 912,82 грн

18.09.2026 21:28
Гук Віктор Степанович ФОП
44,9%`;
    const SINGLE = `0000-068652
19.09.2026
ФОП Берчатов М.М - 59 438.85 грн 10:50
ФОП Берчатова Л.О - 59 371.79 грн 10:50
44,9%`;
    const MINUS = `Закрила Любов Андрейчук :

ФОП Солтик Олександра Олегівна 4 890,00  грн  13:04  17.09.2026

"IBAN:
UA549358710000067320000088286"`;

    const dec = (value: string) => new Prisma.Decimal(value);
    const groupOrders = () =>
      [
        ['0000-068772', '335.58'],
        ['0000-068773', '971.83'],
        ['0000-068774', '605.41'],
      ].map(([number, amount], index) =>
        createdOrder({
          id: index + 1,
          orderNumber: number,
          baseNumber: '0000-068772',
          amountDue: dec(amount!),
        }),
      );
    const singleOrder = () =>
      createdOrder({
        orderNumber: '0000-068652',
        baseNumber: '0000-068652',
        amountDue: dec('118810.64'),
        exchangeRate: dec('44.9'),
      });
    const addedRows = () => [
      {
        id: 1,
        orderId: 1,
        payerName: 'ФОП Берчатов М.М',
        account: null,
        amount: dec('59438.85'),
        paidAt: new Date(),
        addedByTelegramId: USER,
        addedByName: 'Христина',
        createdAt: new Date(),
      },
      {
        id: 2,
        orderId: 1,
        payerName: 'ФОП Берчатова Л.О',
        account: null,
        amount: dec('59371.79'),
        paidAt: new Date(),
        addedByTelegramId: USER,
        addedByName: 'Христина',
        createdAt: new Date(),
      },
    ];

    const begin = async (text: string) => {
      service.startRequisites(USER);
      return service.handleText(MANAGER, text);
    };

    it('should show the format hint and arm waiting for the very next message', () => {
      const reply = service.startRequisites(USER);

      expect(reply.html).toContain('одним повідомленням');
      expect(reply.html).toContain('Файли');
      expect(reply.buttons).toBeUndefined();
    });

    it('should refuse a payment-report-shaped message with guidance when the mode was never armed', async () => {
      const reply = await service.handleText(MANAGER, GROUP);

      expect(reply?.html).toContain('кілька номерів або оплату на чужі реквізити');
      expect(reply?.html).toContain('/requisites');
      expect(orders.createGroup).not.toHaveBeenCalled();
    });

    it('should show what it understood and create nothing until the manager agrees', async () => {
      const reply = await begin(GROUP);

      expect(reply?.html).toContain('кілька номерів однією оплатою');
      expect(reply?.html).toContain('№ <b>0000-068773</b> — 971,83 грн');
      expect(reply?.html).toContain('Разом: <b>1 912,82 грн</b>');
      expect(
        reply?.buttons?.flat().map((b) => ('callback_data' in b ? b.callback_data : null)),
      ).toEqual(['req:ok', 'req:edit', 'req:regular']);
      expect(orders.createGroup).not.toHaveBeenCalled();
      expect(orders.create).not.toHaveBeenCalled();
    });

    it('should create several numbers as one group, as a REGULAR order, with no requisites of their own', async () => {
      orders.createGroup.mockResolvedValue(groupOrders());
      await begin(GROUP);

      const reply = await service.confirmRequisites(MANAGER);

      expect(orders.createGroup).toHaveBeenCalledWith(
        MANAGER.id,
        [
          { orderNumber: '0000-068772', amountDue: '335.58' },
          { orderNumber: '0000-068773', amountDue: '971.83' },
          { orderNumber: '0000-068774', amountDue: '605.41' },
        ],
        {
          clientName: 'Гук Віктор Степанович ФОП',
          exchangeRate: '44.9',
          comment: '18.09.2026 21:28',
        },
      );
      expect(requisites.addMany).not.toHaveBeenCalled();
      expect(sender.sendToAdmins).toHaveBeenCalledTimes(1);
      expect(sender.sendToAdmins).toHaveBeenCalledWith(
        expect.stringContaining('Разом: 1 912,82 грн'),
      );
      expect(reply.html).toContain('3 номерів');
    });

    it('should create one REGULAR order for several recipients and attach each as a structured requisite', async () => {
      orders.create.mockResolvedValue(singleOrder());
      const preview = await begin(SINGLE);
      expect(preview?.html).toContain('порахував');
      expect(preview?.html).toContain('ФОП Берчатов М.М');

      requisites.addMany.mockResolvedValue(addedRows());
      const reply = await service.confirmRequisites(MANAGER);

      expect(orders.create).toHaveBeenCalledWith(
        MANAGER.id,
        {
          clientName: 'ФОП Берчатов М.М',
          exchangeRate: '44.9',
          comment: '19.09.2026',
          orderType: 'REGULAR',
          orderNumber: '0000-068652',
          amountDue: '118810.64',
        },
        { notify: false, addPart: false },
      );
      expect(requisites.addMany).toHaveBeenCalledWith(
        singleOrder().id,
        [
          expect.objectContaining({ payerName: 'ФОП Берчатов М.М', amount: '59438.85' }),
          expect.objectContaining({ payerName: 'ФОП Берчатова Л.О', amount: '59371.79' }),
        ],
        { telegramId: USER, name: 'Христина' },
      );
      expect(sender.sendToAdmins).toHaveBeenCalledWith(expect.stringContaining('ФОП Берчатов М.М'));
      expect(reply.html).toContain('№ <b>0000-068652</b>');
    });

    it('should close a minus with no number and still attach its one requisite', async () => {
      orders.create.mockResolvedValue(
        createdOrder({ orderType: 'MINUS_CLOSING', clientName: 'Закрила Любов Андрейчук' }),
      );
      const preview = await begin(MINUS);
      expect(preview?.html).toContain('закриття мінусу, номера немає');

      await service.confirmRequisites(MANAGER);

      expect(orders.create).toHaveBeenCalledWith(
        MANAGER.id,
        expect.objectContaining({
          orderType: 'MINUS_CLOSING',
          orderNumber: undefined,
          amountDue: '4890.00',
          clientName: 'Закрила Любов Андрейчук',
        }),
        { notify: false, addPart: false },
      );
      expect(requisites.addMany).toHaveBeenCalledWith(
        expect.any(Number),
        [
          expect.objectContaining({
            payerName: 'ФОП Солтик Олександра Олегівна',
            account: 'UA549358710000067320000088286',
          }),
        ],
        expect.anything(),
      );
    });

    it('should ask again when a message sent while armed has no amount', async () => {
      const reply = await begin('0000-068652\nФОП Гук');

      expect(reply?.html).toContain('Не знайшов жодної суми');
      expect(orders.create).not.toHaveBeenCalled();

      orders.create.mockResolvedValue(singleOrder());
      const retry = await service.handleText(MANAGER, SINGLE);
      expect(retry?.html).toContain('Зрозумів так');
    });

    it('should let the manager correct the message', async () => {
      await begin(GROUP);

      expect(service.editRequisites(USER).html).toContain('Надішліть виправлене');
      expect((await service.confirmRequisites(MANAGER)).html).toContain('Немає даних');
      expect((await service.handleText(MANAGER, SINGLE))?.html).toContain('Зрозумів так');
    });

    it('should treat even a perfectly normal order sent while armed via the escape hatch', async () => {
      // Nothing "wrong" with this text — it's just what a manager sends while /requisites is armed.
      const classic = ['0000-066092', 'Носенко Роман', '4 527,00 грн', '44,9', 'Терміново'].join(
        '\n',
      );
      const preview = await begin(classic);
      expect(preview?.html).toContain('Зрозумів так');
      orders.create.mockResolvedValue(
        createdOrder({ orderNumber: '0000-066092', clientName: 'Носенко Роман' }),
      );

      const reply = await service.regularFromRequisites(MANAGER);

      expect(orders.create).toHaveBeenCalledWith(
        MANAGER.id,
        {
          orderType: 'REGULAR',
          orderNumber: '0000-066092',
          clientName: 'Носенко Роман',
          amountDue: '4527.00',
          exchangeRate: '44.9',
          comment: 'Терміново',
        },
        { notify: true, addPart: false },
      );
      expect(reply.html).toContain('створено');
      expect((await service.confirmRequisites(MANAGER)).html).toContain('Немає даних');
    });

    it('should forget the draft on /cancel', async () => {
      await begin(GROUP);

      expect(service.cancel(USER).html).toBe('Скасовано.');
      expect((await service.confirmRequisites(MANAGER)).html).toContain('Немає даних');
    });

    it('should drop a pending preview when another flow starts (leaveRequisites)', async () => {
      await begin(GROUP);

      service.leaveRequisites(USER);

      expect((await service.confirmRequisites(MANAGER)).html).toContain('Немає даних');
      expect((await service.handleText(MANAGER, GROUP))?.html).toContain(
        'кілька номерів або оплату на чужі реквізити',
      );
    });

    it('should not send an answer that is too old, nor to the wrong manager', async () => {
      const now = jest.spyOn(Date, 'now');
      now.mockReturnValue(1_000_000);
      await begin(GROUP);

      const other = { ...MANAGER, id: 8, telegramId: 6000000000n };
      expect((await service.confirmRequisites(other)).html).toContain('Немає даних');

      now.mockReturnValue(1_000_000 + 11 * 60_000);
      expect((await service.confirmRequisites(MANAGER)).html).toContain('Немає даних');
      expect(orders.createGroup).not.toHaveBeenCalled();
      now.mockRestore();
    });

    it('should read a message sent as the caption of a file, once armed', async () => {
      service.startRequisites(USER);
      const reply = await service.addFile(MANAGER, file(), SINGLE);

      expect(reply.html).toContain('Зрозумів так');
      expect(reply.html).toContain('Файлів: 1');
    });

    it('should attach the files to the first order and merge the notice into their caption', async () => {
      orders.createGroup.mockResolvedValue(groupOrders());
      await service.addFile(MANAGER, file());
      await begin(GROUP);

      await service.confirmRequisites(MANAGER);

      expect(attachments.saveFromTelegram).toHaveBeenCalledWith(
        expect.objectContaining({ orderNumber: '0000-068772' }),
        [file()],
        { telegramId: MANAGER.telegramId, name: MANAGER.name },
        true,
        expect.stringContaining('Разом: 1 912,82 грн'),
      );
      expect(sender.sendToAdmins).not.toHaveBeenCalled();
    });

    describe('when a number is already in the system', () => {
      const existing = (orderNumber: string) => ({
        order: { orderNumber, clientName: 'Хтось', amountDue: dec('100') },
        amountPaid: dec('0'),
      });

      it('should add one more part when the only number exists, and say so', async () => {
        orders.findWithBalance.mockResolvedValue(existing('0000-068652'));
        orders.create.mockResolvedValue(singleOrder());
        const preview = await begin(SINGLE);
        expect(preview?.html).toContain('ще однією частиною');

        await service.confirmRequisites(MANAGER);

        expect(orders.create).toHaveBeenCalledWith(MANAGER.id, expect.anything(), {
          notify: false,
          addPart: true,
        });
      });

      it('should refuse when the number belongs to another group', async () => {
        orders.findWithBalance.mockResolvedValue(existing('0000-000001'));

        const reply = await begin(SINGLE);

        expect(reply?.html).toContain('у складі № 0000-000001');
        expect(reply?.buttons).toBeUndefined();
      });

      it('should leave existing numbers out of a group and work out the rest', async () => {
        orders.findWithBalance.mockImplementation((number: string) =>
          Promise.resolve(number === '0000-068773' ? existing('0000-068773') : null),
        );
        orders.createGroup.mockResolvedValue(
          groupOrders().slice(0, 1).concat(groupOrders().slice(2)),
        );

        const preview = await begin(GROUP);
        expect(preview?.html).toContain('Не додаю, бо вони вже є в системі: 0000-068773');
        expect(preview?.html).toContain('Разом: <b>940,99 грн</b>');
        expect(preview?.html).not.toContain('971,83');

        const reply = await service.confirmRequisites(MANAGER);

        expect(orders.createGroup).toHaveBeenCalledWith(
          MANAGER.id,
          [
            { orderNumber: '0000-068772', amountDue: '335.58' },
            { orderNumber: '0000-068774', amountDue: '605.41' },
          ],
          expect.objectContaining({ comment: '18.09.2026 21:28' }),
        );
        expect(sender.sendToAdmins).toHaveBeenCalledWith(
          expect.stringContaining('Не додано (уже є в системі): 0000-068773'),
        );
        expect(reply.html).toContain('Не додано (уже є в системі): 0000-068773');
      });

      it('should refuse a group whose numbers all exist', async () => {
        orders.findWithBalance.mockResolvedValue(existing('0000-068772'));

        const reply = await begin(GROUP);

        expect(reply?.html).toContain('Усі ці номери вже є в системі');
      });
    });

    it('should ask to resend when a number appeared between the preview and the answer', async () => {
      orders.create.mockRejectedValue(new OrderNumberTakenError('0000-068652'));
      await begin(SINGLE);

      const reply = await service.confirmRequisites(MANAGER);

      expect(reply.html).toContain("щойно з'явився");
      expect(sender.sendToAdmins).not.toHaveBeenCalled();
      expect((await service.handleText(MANAGER, SINGLE))?.html).toContain('Зрозумів так');
    });
  });

  describe('onApplicationShutdown', () => {
    it('should warn a manager with buffered files', async () => {
      await service.addFile(MANAGER, file());

      await service.onApplicationShutdown();

      expect(sender.send).toHaveBeenCalledWith(
        MANAGER.telegramId,
        expect.stringContaining('перезапускається'),
      );
    });

    it('should warn a manager with an unanswered part offer', async () => {
      orders.findWithBalance.mockResolvedValue({
        order: {
          orderNumber: '0000-066717',
          clientName: 'Чернявський Владислав',
          amountDue: new Prisma.Decimal('6158.41'),
        },
        amountPaid: new Prisma.Decimal('0'),
      });
      await service.handleText(MANAGER, template());

      await service.onApplicationShutdown();

      expect(sender.send).toHaveBeenCalledWith(MANAGER.telegramId, expect.any(String));
    });

    it('should not warn once the part offer has expired', async () => {
      orders.findWithBalance.mockResolvedValue({
        order: {
          orderNumber: '0000-066717',
          clientName: 'Чернявський Владислав',
          amountDue: new Prisma.Decimal('6158.41'),
        },
        amountPaid: new Prisma.Decimal('0'),
      });
      const now = jest.spyOn(Date, 'now');
      now.mockReturnValue(1_000_000);
      await service.handleText(MANAGER, template());

      now.mockReturnValue(1_000_000 + 11 * 60_000);
      await service.onApplicationShutdown();

      expect(sender.send).not.toHaveBeenCalled();
      now.mockRestore();
    });

    it('should warn a manager who armed the requisites mode', async () => {
      service.startRequisites(USER);

      await service.onApplicationShutdown();

      expect(sender.send).toHaveBeenCalledWith(USER, expect.any(String));
    });

    it('should warn a manager with a pending requisites preview', async () => {
      service.startRequisites(USER);
      await service.handleText(MANAGER, '0000-068772 335,58 грн.\n0000-068773 971,83 грн.\n44,9%');

      await service.onApplicationShutdown();

      expect(sender.send).toHaveBeenCalledWith(USER, expect.any(String));
    });

    it('should warn each affected manager only once, and leave others alone', async () => {
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
