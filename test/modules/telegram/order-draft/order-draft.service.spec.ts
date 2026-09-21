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
  const orders = { findWithBalance: jest.fn(), create: jest.fn() };
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
});
