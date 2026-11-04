import { Logger } from '@nestjs/common';
import type { Manager } from '../../../src/generated/prisma/client';
import { FinanceApiError } from '../../../src/modules/finance-sync/finance.types';
import type { FinanceClient } from '../../../src/modules/finance-sync/finance.client';
import type {
  FinanceFops,
  FinanceRequestView,
} from '../../../src/modules/finance-sync/finance.types';
import type { RequestCardsRepository } from '../../../src/modules/finance-sync/request-cards.repository';
import {
  type ParsedTestRequest,
  parseTestRequest,
  RequestCreateService,
} from '../../../src/modules/finance-sync/request-create.service';
import type { TelegramSender } from '../../../src/modules/telegram/core/telegram-sender';

const ADMIN_CHAT = -1002286861249;
const PLACEHOLDER_ID = 700;
const MANAGER_MESSAGE_ID = 31;

const manager = { id: 4, telegramId: 555n, name: 'Уляна' } as Manager;

const input: ParsedTestRequest = {
  orders: [
    { orderNumber: '0000-070217', amount: '4972' },
    { orderNumber: '0000-072611', amount: '11124.50' },
  ],
  exchangeRate: '45.7',
  comment: 'Терміново',
  officialDocs: true,
};

const view = {
  id: 'req1',
  number: '42',
  status: 'pending',
  kind: 'our_fop',
  sum: '16096.5',
  orders: [
    { orderNumber: '0000-070217', amount: '4972', exchangeRate: null },
    { orderNumber: '0000-072611', amount: '11124.5', exchangeRate: null },
  ],
  payouts: [],
  warnings: [],
  clientLabel: null,
  sheetUrl: null,
  exchangeRate: '45.7',
  officialDocs: true,
  comment: 'Терміново',
} as unknown as FinanceRequestView;

const fops: FinanceFops = {
  limitsEnabled: true,
  limitsStatus: 'ok',
  project: 'P',
  fops: [{ fopId: 9, label: 'ФОП А', leftMonthWithReserve: '120000' }],
};

describe('RequestCreateService', () => {
  const sender = {
    financeEnabled: true,
    adminChatId: ADMIN_CHAT,
    sendToTopic: jest.fn(),
    send: jest.fn(),
    editMessage: jest.fn(),
    deleteMessage: jest.fn(),
  };
  const finance = { create: jest.fn(), fops: jest.fn(), get: jest.fn() };
  const cards = { create: jest.fn(), setManagerMessage: jest.fn() };
  let service: RequestCreateService;

  beforeEach(() => {
    sender.financeEnabled = true;
    sender.sendToTopic.mockResolvedValue(PLACEHOLDER_ID);
    sender.send.mockResolvedValue(MANAGER_MESSAGE_ID);
    sender.editMessage.mockResolvedValue(true);
    finance.create.mockResolvedValue({ id: 'req1', number: '42' });
    finance.fops.mockResolvedValue(fops);
    finance.get.mockResolvedValue({ request: view });
    service = new RequestCreateService(
      sender as unknown as TelegramSender,
      finance as unknown as FinanceClient,
      cards as unknown as RequestCardsRepository,
    );
  });

  afterEach(() => jest.resetAllMocks());

  describe('create', () => {
    it('should create the request, store the mapping and show both cards', async () => {
      const answer = await service.create(manager, input);

      expect(sender.sendToTopic).toHaveBeenCalledWith('requests', '⏳ Створюю запит…');
      expect(finance.create).toHaveBeenCalledWith({
        requesterTelegramId: 555,
        requesterName: 'Уляна',
        kind: 'our_fop',
        orders: [
          { orderNumber: '0000-070217', amount: 4972 },
          { orderNumber: '0000-072611', amount: 11124.5 },
        ],
        exchangeRate: 45.7,
        comment: 'Терміново',
        officialDocs: true,
        groupChatId: ADMIN_CHAT,
        groupMessageId: PLACEHOLDER_ID,
      });
      expect(cards.create).toHaveBeenCalledWith({
        requestId: 'req1',
        number: '42',
        managerId: 4,
        managerChatId: 555n,
        groupChatId: BigInt(ADMIN_CHAT),
        groupMessageId: PLACEHOLDER_ID,
      });
      expect(finance.fops).toHaveBeenCalledWith(555);
      const [chat, messageId, html, buttons] = sender.editMessage.mock.calls[0] as [
        number,
        number,
        string,
        { callback_data: string }[][],
      ];
      expect([chat, messageId]).toEqual([ADMIN_CHAT, PLACEHOLDER_ID]);
      expect(html).toContain('#42');
      expect(buttons.flat().map((b) => b.callback_data)).toContain('ff:req1:9');
      expect(sender.send).toHaveBeenCalledTimes(1);
      expect(sender.send).toHaveBeenCalledWith(
        555n,
        expect.stringContaining('#42'),
        expect.arrayContaining([expect.anything()]),
      );
      expect(cards.setManagerMessage).toHaveBeenCalledWith('req1', MANAGER_MESSAGE_ID);
      expect(sender.deleteMessage).not.toHaveBeenCalled();
      expect(answer).toBeNull();
    });

    it('should send nulls, not undefined, for a missing rate and comment', async () => {
      await service.create(manager, { ...input, exchangeRate: null, comment: null });

      expect(finance.create).toHaveBeenCalledWith(
        expect.objectContaining({ exchangeRate: null, comment: null }),
      );
    });

    it.each([
      [
        'order-taken',
        new FinanceApiError(409, 'order-taken', { orderNumber: '0000-070217' }),
        'номер 0000-070217 уже має відкритий запит',
      ],
      [
        'duplicate-order',
        new FinanceApiError(400, 'duplicate-order'),
        'номер повторюється в запиті',
      ],
    ])('should delete the placeholder and say NOT created on %s', async (_, error, reason) => {
      finance.create.mockRejectedValue(error);

      const answer = await service.create(manager, input);

      expect(sender.deleteMessage).toHaveBeenCalledWith(ADMIN_CHAT, PLACEHOLDER_ID);
      expect(answer?.html).toBe(`⚠️ Запит НЕ створено: ${reason}`);
      expect(cards.create).not.toHaveBeenCalled();
      expect(sender.send).not.toHaveBeenCalled();
    });

    it.each([
      ['timeout', new FinanceApiError(0, 'timeout')],
      ['network', new FinanceApiError(0, 'network')],
      ['a 502', new FinanceApiError(502, 'http-502')],
    ])('should keep the placeholder and not claim failure on %s', async (_, error) => {
      finance.create.mockRejectedValue(error);

      const answer = await service.create(manager, input);

      expect(sender.deleteMessage).not.toHaveBeenCalled();
      expect(sender.editMessage).toHaveBeenCalledWith(
        ADMIN_CHAT,
        PLACEHOLDER_ID,
        '⚠️ Фінанси не відповіли — запит від Уляна міг створитися, перевірте в кабінеті',
      );
      expect(answer?.html).toBe(
        '⚠️ Фінанси не відповіли, тож невідомо, чи створено запит. Спробуйте пізніше: якщо він уже є, бот скаже, що номер має відкритий запит.',
      );
      expect(answer?.html).not.toContain('НЕ створено');
      expect(cards.create).not.toHaveBeenCalled();
    });

    it('should delete the placeholder on a definite 4xx', async () => {
      finance.create.mockRejectedValue(new FinanceApiError(400, 'Bad Request'));

      const answer = await service.create(manager, input);

      expect(sender.deleteMessage).toHaveBeenCalledWith(ADMIN_CHAT, PLACEHOLDER_ID);
      expect(answer?.html).toContain('Запит НЕ створено');
    });

    it('should store the minimal card and warn when the mapping cannot be saved', async () => {
      cards.create.mockRejectedValue(new Error('db down'));
      jest.spyOn(Logger.prototype, 'error').mockImplementation();

      const answer = await service.create(manager, input);

      expect(sender.editMessage).toHaveBeenCalledWith(
        ADMIN_CHAT,
        PLACEHOLDER_ID,
        'Запит #42 · Уляна',
      );
      expect(answer?.html).toBe(
        '✅ Запит #42 створено, але бот не зможе показувати його статус. Перевіряйте в кабінеті.',
      );
      expect(sender.send).not.toHaveBeenCalled();
    });

    it('should not call finance when the placeholder cannot be posted', async () => {
      sender.sendToTopic.mockResolvedValue(null);

      const answer = await service.create(manager, input);

      expect(finance.create).not.toHaveBeenCalled();
      expect(answer?.html).toContain('Запит НЕ створено');
    });

    it('should still create the request, without FOP buttons, when fops fails', async () => {
      finance.fops.mockRejectedValue(new FinanceApiError(0, 'network'));

      const answer = await service.create(manager, input);

      const buttons = (
        sender.editMessage.mock.calls[0] as [number, number, string, unknown[][]]
      )[3];
      expect(JSON.stringify(buttons)).not.toContain('ff:');
      expect(cards.setManagerMessage).toHaveBeenCalledWith('req1', MANAGER_MESSAGE_ID);
      expect(answer).toBeNull();
    });

    it('should confirm the creation plainly when the new request cannot be re-read', async () => {
      finance.get.mockRejectedValue(new FinanceApiError(0, 'timeout'));

      const answer = await service.create(manager, input);

      expect(cards.create).toHaveBeenCalled();
      expect(sender.editMessage).toHaveBeenCalledWith(
        ADMIN_CHAT,
        PLACEHOLDER_ID,
        'Запит #42 · Уляна',
        [[{ text: '🔄 Оновити', callback_data: 'fu:req1' }]],
      );
      expect(answer?.html).toContain('#42');
      expect(answer?.html).not.toContain('НЕ створено');
      expect(sender.send).not.toHaveBeenCalled();
    });

    it('should return the card as a reply when it cannot be sent to the manager', async () => {
      sender.send.mockResolvedValue(null);

      const answer = await service.create(manager, input);

      expect(answer?.html).toContain('#42');
      expect(cards.setManagerMessage).not.toHaveBeenCalled();
    });
  });

  describe('handle', () => {
    const body =
      '0000-070217 4972\n0000-072611 11124,50\nкурс 45,7\nдокументи так\nкоментар Терміново';

    it('should reply that the feature is off, without parsing, when finance is disabled', async () => {
      sender.financeEnabled = false;

      const answer = await service.handle(manager, body);

      expect(answer).toEqual({ html: 'Ця функція ще не ввімкнена.' });
      expect(sender.sendToTopic).not.toHaveBeenCalled();
    });

    it('should parse the body and create the request', async () => {
      await service.handle(manager, body);

      expect(finance.create).toHaveBeenCalledWith(
        expect.objectContaining({ exchangeRate: 45.7, officialDocs: true }),
      );
    });

    it.each([
      ['a missing документи line', '0000-070217 4972'],
      ['a bad sum', '0000-070217 abc\nдокументи так'],
      ['a bad order number', '070217 4972\nдокументи так'],
      ['no orders', 'документи так'],
    ])('should answer a parse error, without calling finance, for %s', async (_, text) => {
      const answer = await service.handle(manager, text);

      expect(answer?.html).toContain('⚠️');
      expect(finance.create).not.toHaveBeenCalled();
      expect(sender.sendToTopic).not.toHaveBeenCalled();
    });
  });
});

describe('parseTestRequest', () => {
  it('should read orders, rate, documents and comment', () => {
    expect(
      parseTestRequest('0000-070217 4972\n0000-072611 11 124,50\nКурс 45,7\nДокументи ні'),
    ).toEqual({
      ok: true,
      value: {
        orders: [
          { orderNumber: '0000-070217', amount: '4972' },
          { orderNumber: '0000-072611', amount: '11124.50' },
        ],
        exchangeRate: '45.7',
        comment: null,
        officialDocs: false,
      },
    });
  });

  it('should reject an unreadable документи value', () => {
    expect(parseTestRequest('0000-070217 4972\nдокументи може')).toMatchObject({ ok: false });
  });

  it('should reject a bad rate', () => {
    expect(parseTestRequest('0000-070217 4972\nкурс abc\nдокументи так')).toMatchObject({
      ok: false,
    });
  });
});
