import type { FinanceRequestCard } from '../../../src/generated/prisma/client';
import { FinancierActionsService } from '../../../src/modules/finance-sync/financier-actions.service';
import type { FinanceClient } from '../../../src/modules/finance-sync/finance.client';
import {
  FinanceApiError,
  type FinanceRequestView,
} from '../../../src/modules/finance-sync/finance.types';
import type { RequestCardsRepository } from '../../../src/modules/finance-sync/request-cards.repository';
import type { RequestSyncService } from '../../../src/modules/finance-sync/request-sync.service';
import type { TelegramSender } from '../../../src/modules/telegram/core/telegram-sender';

const ADMIN_CHAT = -1002286861249;
const BOT_ID = 42;
const FINANCIER_ID = 900;

const card = {
  requestId: 'req1',
  number: '42',
  managerId: 4,
  managerChatId: 555n,
  managerMessageId: 31,
  groupChatId: BigInt(ADMIN_CHAT),
  groupMessageId: 700,
} as FinanceRequestCard;

const pendingView = { id: 'req1', number: '42', status: 'pending' } as FinanceRequestView;
const acceptedView = { ...pendingView, status: 'accepted' } as FinanceRequestView;

describe('FinancierActionsService', () => {
  const sender = { adminChatId: ADMIN_CHAT };
  const finance = { accept: jest.fn(), get: jest.fn() };
  const cards = {
    byRequestId: jest.fn(),
    byGroupMessage: jest.fn(),
  };
  const sync = { renderGroup: jest.fn(), notifyManager: jest.fn() };
  const service = new FinancierActionsService(
    sender as unknown as TelegramSender,
    finance as unknown as FinanceClient,
    cards as unknown as RequestCardsRepository,
    sync as unknown as RequestSyncService,
  );

  beforeEach(() => {
    cards.byRequestId.mockResolvedValue(card);
    finance.get.mockResolvedValue({ request: pendingView });
  });
  afterEach(() => jest.resetAllMocks());

  const press = (match: string[], chatId = ADMIN_CHAT) => ({
    chat: { id: chatId },
    from: { id: FINANCIER_ID },
    match,
    callbackQuery: { message: { message_id: 700, message_thread_id: 12 } },
    answerCbQuery: jest.fn(),
    reply: jest.fn(),
  });

  const textCtx = (text: string, replyTo: object, chatId = ADMIN_CHAT) => ({
    chat: { id: chatId },
    from: { id: FINANCIER_ID },
    botInfo: { id: BOT_ID },
    text,
    message: { message_id: 800, message_thread_id: 12, text, reply_to_message: replyTo },
    reply: jest.fn(),
  });
  const toCard = { message_id: 700, from: { id: BOT_ID }, text: 'Наш ФОП #42' };

  describe('FOP press', () => {
    const fopPress = () => press(['ff:req1:3', 'req1', '3']);

    it('should accept without a rate, redraw the card and notify the manager once', async () => {
      finance.accept.mockResolvedValue(acceptedView);
      const c = fopPress();

      await service.pressFop(c as never);

      expect(finance.accept).toHaveBeenCalledWith('req1', {
        responderTelegramId: FINANCIER_ID,
        fopId: 3,
      });
      expect(sync.renderGroup).toHaveBeenCalledWith(card, acceptedView);
      expect(c.answerCbQuery).toHaveBeenCalledWith('✅ Прийнято');
      expect(sync.notifyManager).toHaveBeenCalledTimes(1);
      expect(sync.notifyManager).toHaveBeenCalledWith(acceptedView);
    });

    it('should alert the limit refusal, refresh the card and not notify on 422', async () => {
      finance.accept.mockRejectedValue(new FinanceApiError(422, 'fop-limit-exceeded'));
      const c = fopPress();

      await service.pressFop(c as never);

      expect(c.answerCbQuery).toHaveBeenCalledWith('Сума перевищує залишок цього ФОП', {
        show_alert: true,
      });
      expect(finance.get).toHaveBeenCalledWith('req1');
      expect(sync.renderGroup).toHaveBeenCalledWith(card, pendingView);
      expect(sync.notifyManager).not.toHaveBeenCalled();
    });

    it('should alert that only a financier can answer on 403', async () => {
      finance.accept.mockRejectedValue(new FinanceApiError(403, 'http-403'));
      const c = fopPress();

      await service.pressFop(c as never);

      expect(c.answerCbQuery).toHaveBeenCalledWith('Відповідати може лише фінансист', {
        show_alert: true,
      });
      expect(sync.notifyManager).not.toHaveBeenCalled();
    });

    it('should ignore a press outside the admin chat', async () => {
      await service.pressFop(press(['ff:req1:3', 'req1', '3'], -1) as never);

      expect(cards.byRequestId).not.toHaveBeenCalled();
      expect(finance.accept).not.toHaveBeenCalled();
    });

    it('should alert when the request is unknown', async () => {
      cards.byRequestId.mockResolvedValue(null);
      const c = fopPress();

      await service.pressFop(c as never);

      expect(c.answerCbQuery).toHaveBeenCalledWith('Запит не знайдено', { show_alert: true });
      expect(finance.accept).not.toHaveBeenCalled();
    });
  });

  describe('refresh', () => {
    it('should redraw the card from finance on refresh', async () => {
      const c = press(['fu:req1', 'req1']);

      await service.refresh(c as never);

      expect(sync.renderGroup).toHaveBeenCalledWith(card, pendingView);
      expect(c.answerCbQuery).toHaveBeenCalled();
    });

    it('should alert when finance does not answer on refresh', async () => {
      finance.get.mockRejectedValue(new FinanceApiError(0, 'timeout'));
      const c = press(['fu:req1', 'req1']);

      await service.refresh(c as never);

      expect(c.answerCbQuery).toHaveBeenCalledWith(
        expect.stringContaining('Фінанси не відповіли'),
        {
          show_alert: true,
        },
      );
      expect(sync.renderGroup).not.toHaveBeenCalled();
    });

    it('should ignore refresh outside the admin chat', async () => {
      await service.refresh(press(['fu:req1', 'req1'], -1) as never);

      expect(cards.byRequestId).not.toHaveBeenCalled();
    });
  });

  describe('text reply in the group', () => {
    beforeEach(() => cards.byGroupMessage.mockResolvedValue(card));

    it.each(['45,7', '41', '200', '45%', '1234', '5', '0'])(
      'should pass on a lone number %s replied to a card and accept nothing',
      async (text) => {
        const c = textCtx(text, toCard);
        const next = jest.fn();

        await service.onText(c as never, next);

        expect(cards.byGroupMessage).toHaveBeenCalledWith(BigInt(ADMIN_CHAT), 700);
        expect(next).toHaveBeenCalledTimes(1);
        expect(finance.accept).not.toHaveBeenCalled();
        expect(sync.renderGroup).not.toHaveBeenCalled();
        expect(c.reply).not.toHaveBeenCalled();
      },
    );

    it('should escape HTML in the refusal sent as a reply', async () => {
      finance.accept.mockRejectedValue(
        new FinanceApiError(422, 'fop-foreign-project', { project: 'Smith & <Sons>' }),
      );
      const c = textCtx('4149 4990 1234 5678', toCard);

      await service.onText(c as never, jest.fn());

      expect(c.reply).toHaveBeenCalledWith(
        'ФОП іншого проєкту (Smith &amp; &lt;Sons&gt;)',
        expect.anything(),
      );
    });

    it('should accept with the payouts text for a card/IBAN reply', async () => {
      finance.accept.mockResolvedValue(acceptedView);
      const text = 'Іваненко 4149 4990 1234 5678\nПетренко 5375 4141 0000 1111';

      await service.onText(textCtx(text, toCard) as never, jest.fn());

      expect(finance.accept).toHaveBeenCalledWith('req1', {
        responderTelegramId: FINANCIER_ID,
        payoutsText: text,
      });
      expect(sync.renderGroup).toHaveBeenCalledWith(expect.anything(), acceptedView);
      expect(sync.notifyManager).toHaveBeenCalledWith(acceptedView);
    });

    it('should accept with the FOP name for a «ФОП …» reply', async () => {
      finance.accept.mockResolvedValue(acceptedView);

      await service.onText(textCtx(' Фоп Гук) ', toCard) as never, jest.fn());

      expect(finance.accept).toHaveBeenCalledWith('req1', {
        responderTelegramId: FINANCIER_ID,
        fopName: 'Фоп Гук)',
      });
      expect(sync.renderGroup).toHaveBeenCalledWith(expect.anything(), acceptedView);
      expect(sync.notifyManager).toHaveBeenCalledWith(acceptedView);
    });

    it('should pass on a long sentence that only starts with «ФОП»', async () => {
      const next = jest.fn();
      const text =
        'фоп сьогодні не працює, бо банк заблокував рахунок до кінця тижня, напишу пізніше';

      await service.onText(textCtx(text, toCard) as never, next);

      expect(finance.accept).not.toHaveBeenCalled();
      expect(next).toHaveBeenCalled();
    });

    it('should reply with the refusal when accepting payouts fails', async () => {
      finance.accept.mockRejectedValue(new FinanceApiError(422, 'payouts-unrecognized'));
      const c = textCtx('4149 4990 1234 5678', toCard);

      await service.onText(c as never, jest.fn());

      expect(c.reply).toHaveBeenCalledWith('Не розпізнав реквізити', expect.anything());
      expect(sync.notifyManager).not.toHaveBeenCalled();
    });

    it('should ignore plain chat replying to a card and pass it on', async () => {
      const next = jest.fn();

      await service.onText(textCtx('дякую, гляну', toCard) as never, next);

      expect(finance.accept).not.toHaveBeenCalled();
      expect(next).toHaveBeenCalled();
    });

    it('should pass on a reply to a message that is not a card', async () => {
      cards.byGroupMessage.mockResolvedValue(null);
      const next = jest.fn();

      await service.onText(textCtx('45,7', { message_id: 5 }) as never, next);

      expect(next).toHaveBeenCalled();
    });

    it('should pass on text that is not a reply, a command, or outside the admin chat', async () => {
      const next = jest.fn();
      const plain = { ...textCtx('45,7', toCard), message: { message_id: 1, text: '45,7' } };

      await service.onText(plain as never, next);
      await service.onText(textCtx('/report', toCard) as never, next);
      await service.onText(textCtx('45,7', toCard, -1) as never, next);

      expect(next).toHaveBeenCalledTimes(3);
      expect(cards.byGroupMessage).not.toHaveBeenCalled();
    });
  });
});
