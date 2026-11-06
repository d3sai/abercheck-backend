import type { FinanceRequestCard } from '../../../src/generated/prisma/client';
import type { FinanceClient } from '../../../src/modules/finance-sync/finance.client';
import {
  FinanceApiError,
  type FinanceEvent,
  type FinanceRequestView,
} from '../../../src/modules/finance-sync/finance.types';
import type { RequestCardsRepository } from '../../../src/modules/finance-sync/request-cards.repository';
import { RequestSyncService } from '../../../src/modules/finance-sync/request-sync.service';
import type { OrdersService } from '../../../src/modules/orders/orders.service';
import type { ManagersService } from '../../../src/modules/managers/managers.service';
import type { TelegramSender } from '../../../src/modules/telegram/core/telegram-sender';

const card = {
  requestId: 'req1',
  number: '42',
  managerId: 4,
  managerChatId: 555n,
  managerMessageId: 31,
  groupChatId: -1002n,
  groupMessageId: 700,
} as FinanceRequestCard;

const view = (patch: Partial<FinanceRequestView> = {}) =>
  ({
    id: 'req1',
    number: '42',
    status: 'pending',
    kind: 'our_fop',
    sum: '100',
    orders: [],
    payouts: [],
    warnings: [],
    isPaid: false,
    fopLabel: 'ФОП Іванов',
    ...patch,
  }) as unknown as FinanceRequestView;

describe('RequestSyncService', () => {
  const sender = {
    miniAppUrl: undefined as string | undefined,
    send: jest.fn(),
    editMessage: jest.fn(),
    sendDocument: jest.fn(),
  };
  const orders = { numbersByIds: jest.fn(), latestPaidAt: jest.fn() };
  const finance = { fops: jest.fn(), get: jest.fn(), file: jest.fn() };
  const cards = {
    byRequestId: jest.fn(),
    markNotified: jest.fn(),
    resetNotified: jest.fn(),
    markSeen: jest.fn(),
    unmarkSeen: jest.fn(),
    rememberChatMessage: jest.fn(),
  };
  const managers = { findById: jest.fn() };
  const service = new RequestSyncService(
    sender as unknown as TelegramSender,
    finance as unknown as FinanceClient,
    cards as unknown as RequestCardsRepository,
    managers as unknown as ManagersService,
    orders as unknown as OrdersService,
  );

  beforeEach(() => {
    cards.byRequestId.mockResolvedValue(card);
    cards.markNotified.mockResolvedValue(true);
    cards.markSeen.mockResolvedValue(true);
    sender.send.mockResolvedValue(77);
    sender.sendDocument.mockResolvedValue(78);
    managers.findById.mockResolvedValue({ name: 'Уляна' });
    sender.miniAppUrl = undefined;
  });
  afterEach(() => jest.resetAllMocks());

  describe('notifyManager', () => {
    it.each([
      ['accepted', { status: 'accepted' }, '✅ Запит #42 прийнято · ФОП: ФОП Іванов'],
      ['cancelled', { status: 'cancelled' }, '❌ Запит #42 скасовано'],
      ['paid', { status: 'accepted', isPaid: true }, '💰 Запит #42 оплачено'],
    ] as const)(
      'should send the %s notice as a reply to the manager card',
      async (status, patch, text) => {
        await service.notifyManager(view(patch));

        expect(cards.markNotified).toHaveBeenCalledWith('req1', status);
        expect(sender.send).toHaveBeenCalledWith(555n, text, undefined, false, { replyTo: 31 });
      },
    );

    it('should stay silent when this status was already notified', async () => {
      cards.markNotified.mockResolvedValue(false);

      await service.notifyManager(view({ status: 'accepted' }));

      expect(sender.send).not.toHaveBeenCalled();
    });

    it('should do nothing for a pending request or an unknown card', async () => {
      await service.notifyManager(view());
      cards.byRequestId.mockResolvedValue(null);
      await service.notifyManager(view({ status: 'cancelled' }));

      expect(cards.markNotified).not.toHaveBeenCalled();
      expect(sender.send).not.toHaveBeenCalled();
    });

    it('should revert the notified status when the notice could not be sent, so a retry notifies again', async () => {
      sender.send.mockResolvedValue(null);

      await service.notifyManager(view({ status: 'accepted' }));

      expect(cards.resetNotified).toHaveBeenCalledWith('req1', 'accepted');
    });

    it('should remember the notice so a manager reply to it reaches the request chat', async () => {
      await service.notifyManager(view({ status: 'accepted' }));

      expect(cards.rememberChatMessage).toHaveBeenCalledWith(555n, 77, 'req1');
    });

    it('should not remember a notice that was not sent', async () => {
      sender.send.mockResolvedValue(null);

      await service.notifyManager(view({ status: 'accepted' }));

      expect(cards.rememberChatMessage).not.toHaveBeenCalled();
    });

    it('should keep the notified status when the notice was sent', async () => {
      await service.notifyManager(view({ status: 'accepted' }));

      expect(cards.resetNotified).not.toHaveBeenCalled();
    });

    it('should leave out the FOP when the request has none', async () => {
      await service.notifyManager(view({ status: 'accepted', fopLabel: null }));

      expect(sender.send).toHaveBeenCalledWith(555n, '✅ Запит #42 прийнято', undefined, false, {
        replyTo: 31,
      });
    });
  });

  describe('renderManager', () => {
    const URL_ = 'https://cab.example.ua/tg/request';
    type Edit = [bigint, number, string, { text: string }[][] | undefined];
    const edit = (index = 0) => sender.editMessage.mock.calls[index] as Edit;

    it('should add the Mini App buttons to a pending card when the URL is set', async () => {
      sender.miniAppUrl = URL_;

      await service.renderManager(card, view());

      const buttons = edit()[3]!;
      expect(buttons[0]!.map((b) => b.text)).toEqual(['✏️ Змінити', '✖ Скасувати запит']);
      expect(orders.numbersByIds).not.toHaveBeenCalled();
    });

    it('should show the stored payments and offer «Прийняти» on an accepted card that is not completed', async () => {
      sender.miniAppUrl = URL_;
      const payments = [
        { payerName: 'Іван', account: null, amount: '700', paidAt: '2026-11-04T08:15:00.000Z' },
      ];

      await service.renderManager(
        { ...card, payments },
        view({ status: 'accepted', kind: 'card' }),
      );

      const [, , html, buttons] = edit();
      expect(buttons!.flat().map((b) => b.text)).toEqual(['✅ Прийняти', '✏️ Змінити']);
      expect(html).toContain('• Іван · 700 грн · 04.11.2026 10:15');
    });

    it('should keep the «Оформлено» line and drop the buttons for a completed card of a closed kind', async () => {
      sender.miniAppUrl = URL_;
      orders.numbersByIds.mockResolvedValue(['0000-1', '0000-2']);

      await service.renderManager(
        { ...card, completedAt: new Date(), closedAt: new Date(), orderIds: [10, 11] },
        view({ status: 'accepted', kind: 'card' }),
      );

      expect(orders.numbersByIds).toHaveBeenCalledWith([10, 11]);
      const [, , html, buttons] = edit();
      expect(html).toContain('✅ Оформлено: № 0000-1, 0000-2 (2 замовлення)');
      expect(buttons).toBeUndefined();
      expect(orders.latestPaidAt).not.toHaveBeenCalled();
    });

    it('should offer «Оплачено» on a completed our_fop that is still open', async () => {
      sender.miniAppUrl = URL_;
      orders.numbersByIds.mockResolvedValue(['0000-1']);

      await service.renderManager(
        { ...card, completedAt: new Date(), closedAt: null, orderIds: [10] },
        view({ status: 'accepted', kind: 'our_fop' }),
      );

      expect(
        edit()[3]!
          .flat()
          .map((b) => b.text),
      ).toEqual(['💰 Оплачено']);
    });

    it('should show when a closed our_fop was paid', async () => {
      orders.numbersByIds.mockResolvedValue(['0000-1']);
      orders.latestPaidAt.mockResolvedValue(new Date('2026-11-04T12:30:00.000Z'));

      await service.renderManager(
        { ...card, completedAt: new Date(), closedAt: new Date(), orderIds: [10] },
        view({ status: 'accepted', kind: 'our_fop' }),
      );

      expect(orders.latestPaidAt).toHaveBeenCalledWith([10]);
      expect(edit()[2]).toContain('✅ Оплачено 04.11.2026 14:30 · закрито');
      expect(edit()[3]).toBeUndefined();
    });

    it('should draw a completed card with no orders without a number', async () => {
      orders.numbersByIds.mockResolvedValue([]);

      await service.renderManager(
        { ...card, completedAt: new Date(), orderIds: [] },
        view({ status: 'accepted' }),
      );

      expect(edit()[2]).toMatch(/✅ Оформлено$/);
    });

    it('should show the line again on a webhook redraw', async () => {
      orders.numbersByIds.mockResolvedValue(['0000-1']);
      cards.byRequestId.mockResolvedValue({ ...card, completedAt: new Date(), orderIds: [10] });
      finance.get.mockResolvedValue({ request: view({ status: 'accepted' }) });

      await service.handle({ type: 'accepted', requestId: 'req1', request: view() });

      const managerEdit = [edit(0), edit(1)].find(([chat]) => chat === 555n)!;
      expect(managerEdit[2]).toContain('✅ Оформлено: № 0000-1');
    });
  });

  describe('renderGroup', () => {
    it('should edit the group card with FOP buttons and the manager name for a pending request', async () => {
      finance.fops.mockResolvedValue({
        limitsEnabled: true,
        limitsStatus: 'ok',
        project: null,
        fops: [{ fopId: 3, label: 'ФОП А', leftMonthWithReserve: '1000' }],
      });
      managers.findById.mockResolvedValue({ name: 'Уляна' });

      await service.renderGroup(card, view());

      expect(finance.fops).toHaveBeenCalledWith(555);
      expect(sender.editMessage).toHaveBeenCalledWith(
        -1002n,
        700,
        expect.stringContaining('Менеджер: Уляна'),
        expect.arrayContaining([[expect.objectContaining({ callback_data: 'ff:req1:3' })]]),
      );
    });

    it('should still edit the card when the FOP list is unavailable, and skip it once closed', async () => {
      finance.fops.mockRejectedValue(new Error('down'));
      managers.findById.mockResolvedValue({ name: 'Уляна' });

      await service.renderGroup(card, view());
      await service.renderGroup(card, view({ status: 'accepted' }));

      expect(sender.editMessage).toHaveBeenCalledTimes(2);
      expect(finance.fops).toHaveBeenCalledTimes(1);
    });
  });

  describe('handle', () => {
    const event = (patch: Partial<FinanceEvent> = {}): FinanceEvent => ({
      type: 'accepted',
      requestId: 'req1',
      request: view({ status: 'pending' }),
      ...patch,
    });
    const message = {
      messageId: 'm1',
      author: 'Олена',
      body: 'Де <чек>?',
      fileName: null,
    };

    beforeEach(() => finance.get.mockResolvedValue({ request: view({ status: 'accepted' }) }));

    it('should do nothing for an unknown request', async () => {
      cards.byRequestId.mockResolvedValue(null);

      await service.handle(event());

      expect(finance.get).not.toHaveBeenCalled();
      expect(sender.editMessage).not.toHaveBeenCalled();
      expect(sender.send).not.toHaveBeenCalled();
    });

    it('should redraw both cards from the re-read view, not from the event snapshot, then notify', async () => {
      await service.handle(event({ type: 'accepted' }));

      expect(finance.get).toHaveBeenCalledWith('req1');
      expect(sender.editMessage).toHaveBeenCalledWith(
        -1002n,
        700,
        expect.stringContaining('Прийняв'),
        undefined,
      );
      expect(sender.editMessage).toHaveBeenCalledWith(
        555n,
        31,
        expect.stringContaining('Прийняв'),
        [[{ text: '✅ Прийняти', callback_data: 'mo:req1' }]],
      );
      expect(sender.send).toHaveBeenCalledWith(
        555n,
        '✅ Запит #42 прийнято · ФОП: ФОП Іванов',
        undefined,
        false,
        { replyTo: 31 },
      );
    });

    it('should keep the cancel button on the manager card while the request is pending', async () => {
      finance.get.mockResolvedValue({ request: view() });
      finance.fops.mockResolvedValue({ limitsStatus: 'ok', fops: [] });

      await service.handle(event({ type: 'edited' }));

      expect(sender.editMessage).toHaveBeenCalledWith(
        555n,
        31,
        expect.any(String),
        expect.arrayContaining([[expect.objectContaining({ callback_data: 'fc:req1' })]]),
      );
      expect(sender.send).not.toHaveBeenCalled();
    });

    it('should send one notice for the same accepted event delivered twice', async () => {
      cards.markNotified.mockResolvedValueOnce(true).mockResolvedValueOnce(false);

      await service.handle(event());
      await service.handle(event());

      expect(sender.send).toHaveBeenCalledTimes(1);
    });

    it('should stay silent for the echo of our own accept, which already notified', async () => {
      cards.markNotified.mockResolvedValue(false);

      await service.handle(event());

      expect(sender.send).not.toHaveBeenCalled();
    });

    it('should let a finance failure through, so the webhook answers 500 and finance retries', async () => {
      finance.get.mockRejectedValue(new FinanceApiError(0, 'network'));

      await expect(service.handle(event())).rejects.toThrow(FinanceApiError);
    });

    describe('message events', () => {
      it('should relay a text message as a reply to the manager card and remember it', async () => {
        await service.handle(event({ type: 'message', message }));

        expect(cards.markSeen).toHaveBeenCalledWith('m1');
        expect(sender.send).toHaveBeenCalledWith(
          555n,
          '💬 Олена: Де &lt;чек&gt;?',
          undefined,
          false,
          { replyTo: 31 },
        );
        expect(cards.rememberChatMessage).toHaveBeenCalledWith(555n, 77, 'req1');
      });

      it('should deliver the same message once', async () => {
        cards.markNotified.mockResolvedValue(false);
        cards.markSeen.mockResolvedValueOnce(true).mockResolvedValueOnce(false);

        await service.handle(event({ type: 'message', message }));
        await service.handle(event({ type: 'message', message }));

        expect(sender.send).toHaveBeenCalledTimes(1);
      });

      it('should fetch a file and send it as a document replying to the manager card', async () => {
        cards.markNotified.mockResolvedValue(false);
        const data = Buffer.from('pdf');
        finance.file.mockResolvedValue({ data, filename: 'chek.pdf', mimeType: 'application/pdf' });

        await service.handle(
          event({ type: 'message', message: { ...message, body: null, fileName: 'chek.pdf' } }),
        );

        expect(finance.file).toHaveBeenCalledWith('req1', 'm1');
        expect(sender.sendDocument).toHaveBeenCalledWith(
          555n,
          { source: data, filename: 'chek.pdf' },
          '💬 Олена',
          31,
        );
        expect(sender.send).not.toHaveBeenCalled();
        expect(cards.rememberChatMessage).toHaveBeenCalledWith(555n, 78, 'req1');
      });

      it('should forget the message and fail when delivery failed, so finance retries', async () => {
        cards.markNotified.mockResolvedValue(false);
        sender.send.mockResolvedValue(null);

        await expect(service.handle(event({ type: 'message', message }))).rejects.toThrow();

        expect(cards.unmarkSeen).toHaveBeenCalledWith('m1');
      });

      it('should send nothing when a message with text and a file cannot fetch its file', async () => {
        cards.markNotified.mockResolvedValue(false);
        finance.file.mockRejectedValue(new FinanceApiError(0, 'timeout'));

        await expect(
          service.handle(event({ type: 'message', message: { ...message, fileName: 'a.pdf' } })),
        ).rejects.toThrow(FinanceApiError);

        expect(sender.send).not.toHaveBeenCalled();
        expect(sender.sendDocument).not.toHaveBeenCalled();
        expect(cards.unmarkSeen).toHaveBeenCalledWith('m1');
      });

      it('should forget the message when the file cannot be fetched', async () => {
        cards.markNotified.mockResolvedValue(false);
        finance.file.mockRejectedValue(new FinanceApiError(0, 'timeout'));

        await expect(
          service.handle(
            event({ type: 'message', message: { ...message, body: null, fileName: 'a.pdf' } }),
          ),
        ).rejects.toThrow(FinanceApiError);

        expect(cards.unmarkSeen).toHaveBeenCalledWith('m1');
      });
    });
  });
});
