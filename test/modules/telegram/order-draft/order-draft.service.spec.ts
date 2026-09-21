import { Test } from '@nestjs/testing';
import { type Manager, OrderType, Prisma } from '../../../../src/generated/prisma/client';
import { AttachmentsService } from '../../../../src/modules/attachments/attachments.service';
import { OrderNumberTakenError } from '../../../../src/modules/orders/orders.errors';
import { OrdersService } from '../../../../src/modules/orders/orders.service';
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
  const orders = { findWithBalance: jest.fn(), create: jest.fn(), createGroup: jest.fn() };
  const attachments = { saveFromTelegram: jest.fn() };
  const sender = { sendToAdmins: jest.fn() };
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
        { provide: AttachmentsService, useValue: attachments },
        { provide: TelegramSender, useValue: sender },
      ],
    }).compile();

    service = moduleRef.get(OrderDraftService);
    orders.findWithBalance.mockResolvedValue(null);
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
      expect(reply.html).toContain('1/5');
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
      for (let i = 0; i < 5; i += 1) {
        await service.addFile(MANAGER, file(`f${i}.png`));
      }

      const reply = await service.addFile(MANAGER, file('overflow.png'));

      expect(reply.html).toContain('Максимум 5');
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
      expect(reply.html).toContain('1/5');
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

  describe('a payment to other requisites', () => {
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
          orderType: 'REQUISITES',
          amountDue: dec(amount!),
          ...(index === 0
            ? { requisites: 'Гук Віктор Степанович ФОП', comment: '18.09.2026 21:28' }
            : { comment: 'Оплата разом із № 0000-068772' }),
        }),
      );
    const singleOrder = () =>
      createdOrder({
        orderNumber: '0000-068652',
        baseNumber: '0000-068652',
        orderType: 'REQUISITES',
        amountDue: dec('118810.64'),
        exchangeRate: dec('44.9'),
        comment: '19.09.2026',
        requisites:
          'ФОП Берчатов М.М - 59 438.85 грн 10:50\nФОП Берчатова Л.О - 59 371.79 грн 10:50',
      });

    const begin = async (text: string) => {
      service.startRequisites(USER);
      return service.handleText(MANAGER, text);
    };

    it('should explain the format and start waiting for one free-form message', () => {
      const reply = service.startRequisites(USER);

      expect(reply.html).toContain('Оплата на інші реквізити');
      expect(reply.html).toContain('зі словом «грн»');
      expect(reply.buttons).toBeUndefined();
    });

    it('should show what it understood and create nothing until the manager agrees', async () => {
      const reply = await begin(GROUP);

      expect(reply?.html).toContain('кілька номерів однією оплатою');
      expect(reply?.html).toContain('№ <b>0000-068773</b> — 971,83 грн');
      expect(reply?.html).toContain('Разом: <b>1 912,82 грн</b>');
      expect(reply?.html).toContain('Курс: 44,9');
      expect(
        reply?.buttons?.flat().map((b) => ('callback_data' in b ? b.callback_data : null)),
      ).toEqual(['req:ok', 'req:edit']);
      expect(orders.createGroup).not.toHaveBeenCalled();
      expect(orders.create).not.toHaveBeenCalled();
    });

    it('should create several numbers as one group and tell the admins once', async () => {
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
          requisites: 'Гук Віктор Степанович ФОП',
        },
      );
      expect(sender.sendToAdmins).toHaveBeenCalledTimes(1);
      expect(sender.sendToAdmins).toHaveBeenCalledWith(
        expect.stringContaining('Разом: 1 912,82 грн'),
      );
      expect(reply.html).toContain('3 номерів');
    });

    it('should create one order for a number paid to several recipients, with the text as it was', async () => {
      orders.create.mockResolvedValue(singleOrder());
      const preview = await begin(SINGLE);
      expect(preview?.html).toContain('Сума: <b>118 810,64 грн</b> (59 438,85 + 59 371,79)');
      expect(preview?.html).toContain('порахував');

      const reply = await service.confirmRequisites(MANAGER);

      expect(orders.create).toHaveBeenCalledWith(
        MANAGER.id,
        {
          clientName: 'ФОП Берчатов М.М +1',
          exchangeRate: '44.9',
          comment: '19.09.2026',
          requisites:
            'ФОП Берчатов М.М - 59 438.85 грн 10:50\nФОП Берчатова Л.О - 59 371.79 грн 10:50',
          orderType: 'REQUISITES',
          orderNumber: '0000-068652',
          amountDue: '118810.64',
        },
        { notify: false, addPart: false },
      );
      expect(sender.sendToAdmins).toHaveBeenCalledWith(
        expect.stringContaining('ФОП Берчатов М.М - 59 438.85 грн 10:50'),
      );
      expect(reply.html).toContain('№ <b>0000-068652</b>');
    });

    it('should close a minus when there is no number', async () => {
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
    });

    it('should ask again, and keep waiting, when the message has no amount', async () => {
      const reply = await begin('0000-068652\nФОП Гук');

      expect(reply?.html).toContain('Не знайшов жодної суми');
      expect(orders.create).not.toHaveBeenCalled();

      orders.create.mockResolvedValue(singleOrder());
      const retry = await service.handleText(MANAGER, SINGLE);
      expect(retry?.html).toContain('Зрозумів так');
    });

    it('should treat the next message as a regular order again once the payment is sent', async () => {
      orders.create.mockResolvedValue(singleOrder());
      await begin(SINGLE);
      await service.confirmRequisites(MANAGER);

      const next = await service.handleText(MANAGER, 'привіт, як справи?');

      expect(next).toBeNull();
    });

    it('should let the manager correct the message', async () => {
      await begin(GROUP);

      expect(service.editRequisites(USER).html).toContain('Надішліть виправлене');
      expect((await service.confirmRequisites(MANAGER)).html).toContain('Немає даних');
      expect((await service.handleText(MANAGER, SINGLE))?.html).toContain('Зрозумів так');
    });

    it('should stop waiting when another flow starts or on cancel', async () => {
      await begin(GROUP);
      service.leaveRequisites(USER);
      expect(await service.handleText(MANAGER, 'привіт')).toBeNull();

      service.startRequisites(USER);
      expect(service.cancel(USER).html).toBe('Скасовано.');
      expect(await service.handleText(MANAGER, 'привіт')).toBeNull();
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

    it('should read a message sent as the caption of a file', async () => {
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

    it('should lay the preview out in the order of the regular template', async () => {
      const preview = await begin(`0000-066092
07.09.2026
ФОП Носенко Роман - 4 527,00 грн 14:57
4441 1110 6964 5962 Андріанов Олександр - 2 140,00 грн 14:59
45`);

      const html = preview?.html ?? '';
      const order = [
        '№ <b>0000-066092</b>',
        'Реквізити:',
        'Сума:',
        'Курс: 45',
        'Коментар: 07.09.2026',
      ];
      const positions = order.map((part) => html.indexOf(part));
      expect(positions.every((position) => position >= 0)).toBe(true);
      expect([...positions].sort((a, b) => a - b)).toEqual(positions);
      expect(html).toContain(
        '<pre>ФОП Носенко Роман - 4 527,00 грн 14:57\n4441 1110 6964 5962 Андріанов Олександр - 2 140,00 грн 14:59</pre>',
      );
      expect(html).toContain('Сума: <b>6 667 грн</b> (4 527 + 2 140)');
    });

    describe('recognised without the button', () => {
      const TWELVE = `0000-063555  20 639 грн (залишок)
0000-064272  2 044,29 грн
0000-064579  2 044,29 грн

27/08/2026 16:33
ФОП Івченко Євгеній Вадимович 75 000,00 грн
"UA573052990000026005031228837
3153718452
Призначення платежу : Оплата за товар"
Івченко Євгеній виплата на (ФОП Івченко Євгеній Вадимович) 75 000,00 грн

44,9`;
      const TWO_RECIPIENTS = `0000-066092
07.09.2026
ФОП Носенко Роман - 4 527,00 грн 14:57
ФОП Андріанов Олександр - 2 140,00 грн 14:59
45`;
      const REGULAR = '0000-066717\nЧернявський Владислав\n6 158,41 грн\n44,9\nТерміново';
      const buttonsOf = (
        reply: { buttons?: { text: string; callback_data?: string }[][] } | null,
      ) => reply?.buttons?.flat().map((b) => b.callback_data);

      it('should take over a message with several numbers and an IBAN instead of failing', async () => {
        const reply = await service.handleText(MANAGER, TWELVE);

        expect(reply?.html).toContain('Схоже на оплату на інші реквізити — розібрав як таку.');
        expect(reply?.html).toContain('кілька номерів однією оплатою');
        expect(buttonsOf(reply)).toEqual(['req:ok', 'req:edit', 'req:regular']);
        expect(orders.create).not.toHaveBeenCalled();
        expect(orders.createGroup).not.toHaveBeenCalled();
      });

      it('should not turn recipients with a lone rate into a regular order of 45 грн', async () => {
        const reply = await service.handleText(MANAGER, TWO_RECIPIENTS);

        expect(reply?.html).toContain('Сума: <b>6 667 грн</b>');
        expect(orders.create).not.toHaveBeenCalled();
      });

      it('should create the group when the manager agrees, as if the button had been pressed', async () => {
        orders.createGroup.mockResolvedValue(groupOrders().slice(0, 2));
        await service.handleText(MANAGER, GROUP);

        await service.confirmRequisites(MANAGER);

        expect(orders.createGroup).toHaveBeenCalledTimes(1);
        expect(sender.sendToAdmins).toHaveBeenCalledTimes(1);
      });

      it('should recognise it in the caption of a file too', async () => {
        const reply = await service.addFile(MANAGER, file(), TWELVE);

        expect(reply.html).toContain('Схоже на оплату на інші реквізити');
        expect(reply.html).toContain('Файлів: 1');
      });

      it('should leave a regular order alone', async () => {
        orders.create.mockResolvedValue(createdOrder());

        const reply = await service.handleText(MANAGER, REGULAR);

        expect(orders.create).toHaveBeenCalledWith(
          MANAGER.id,
          expect.objectContaining({ orderType: 'REGULAR', orderNumber: '0000-066717' }),
          { notify: true, addPart: false },
        );
        expect(reply?.html).toContain('створено');
      });

      it('should leave a labelled template alone even when a comment mentions money', async () => {
        orders.create.mockResolvedValue(createdOrder());

        await service.handleText(
          MANAGER,
          template({ Сума: '6 158,41 грн', Коментар: 'доплата 500 грн' }),
        );

        expect(orders.create).toHaveBeenCalledTimes(1);
      });

      it('should ignore plain chat text', async () => {
        expect(await service.handleText(MANAGER, 'привіт, як справи?')).toBeNull();
      });

      it('should read the same text as a regular order when the manager says it is one', async () => {
        orders.create.mockResolvedValue(createdOrder());
        const preview = await service.handleText(
          MANAGER,
          '0000-066717\nЧернявський Владислав\n6 158,41 грн\n44,9\nдоплата 500 грн',
        );
        expect(preview?.html).toContain('Схоже на оплату на інші реквізити');
        expect(orders.create).not.toHaveBeenCalled();

        const reply = await service.regularFromDraft(MANAGER);

        expect(orders.create).toHaveBeenCalledWith(
          MANAGER.id,
          expect.objectContaining({
            orderType: 'REGULAR',
            orderNumber: '0000-066717',
            clientName: 'Чернявський Владислав',
            comment: 'доплата 500 грн',
          }),
          { notify: true, addPart: false },
        );
        expect(reply.html).toContain('створено');
        expect(await service.handleText(MANAGER, 'привіт')).toBeNull();
      });

      it('should say so when nothing is waiting, and explain when it does not fit the regular template', async () => {
        expect((await service.regularFromDraft(MANAGER)).html).toContain('Немає даних');

        const long = [
          ...Array.from({ length: 12 }, (_, i) => `0000-06${4000 + i}  2 044,29 грн`),
          '',
          '27/08/2026 16:33',
          'ФОП Івченко Євгеній Вадимович 75 000,00 грн',
          'UA573052990000026005031228837',
          'Призначення платежу : Оплата за товар',
          '44,9',
        ].join('\n');
        await service.handleText(MANAGER, long);

        const reply = await service.regularFromDraft(MANAGER);

        expect(reply.html).toContain('Виправте');
        expect(orders.create).not.toHaveBeenCalled();
      });

      it('should not show the button for a message the manager started with the button', async () => {
        const reply = await begin(TWELVE);

        expect(buttonsOf(reply)).toEqual(['req:ok', 'req:edit']);
        expect(reply?.html).not.toContain('Схоже на оплату');
      });
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
});
