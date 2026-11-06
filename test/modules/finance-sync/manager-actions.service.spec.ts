import type { FinanceRequestCard } from '../../../src/generated/prisma/client';
import type { ManagersService } from '../../../src/modules/managers/managers.service';
import type { FinanceClient } from '../../../src/modules/finance-sync/finance.client';
import {
  FinanceApiError,
  type FinanceRequestView,
} from '../../../src/modules/finance-sync/finance.types';
import { NOT_A_MANAGER } from '../../../src/modules/telegram/access/access.messages';
import { ManagerActionsService } from '../../../src/modules/finance-sync/manager-actions.service';
import type { RequestCardsRepository } from '../../../src/modules/finance-sync/request-cards.repository';
import type { RequestSyncService } from '../../../src/modules/finance-sync/request-sync.service';

const MANAGER_CHAT = 555;

const card = {
  requestId: 'req1',
  number: '42',
  managerChatId: BigInt(MANAGER_CHAT),
  managerMessageId: 31,
  groupChatId: -1002n,
  groupMessageId: 700,
} as FinanceRequestCard;

const cancelledView = { id: 'req1', number: '42', status: 'cancelled' } as FinanceRequestView;

describe('ManagerActionsService', () => {
  const finance = { cancel: jest.fn(), get: jest.fn(), postMessage: jest.fn() };
  const cards = {
    byRequestId: jest.fn(),
    byManagerMessage: jest.fn(),
    requestOfChatMessage: jest.fn(),
  };
  const sync = { renderGroup: jest.fn(), renderManager: jest.fn(), notifyManager: jest.fn() };
  const managers = { findActiveByTelegramId: jest.fn() };
  const service = new ManagerActionsService(
    finance as unknown as FinanceClient,
    cards as unknown as RequestCardsRepository,
    sync as unknown as RequestSyncService,
    managers as unknown as ManagersService,
  );

  beforeEach(() => {
    cards.byRequestId.mockResolvedValue(card);
    managers.findActiveByTelegramId.mockResolvedValue({ id: 4 });
  });
  afterEach(() => jest.resetAllMocks());

  const press = (chatId = MANAGER_CHAT, type = 'private') => ({
    chat: { id: chatId, type },
    from: { id: 555, first_name: 'Іван', last_name: 'Петренко' },
    match: ['fc:req1', 'req1'],
    answerCbQuery: jest.fn(),
  });

  describe('cancel', () => {
    it('should cancel through finance, redraw both cards and notify', async () => {
      finance.cancel.mockResolvedValue(cancelledView);
      const c = press();

      await service.cancel(c as never);

      expect(finance.cancel).toHaveBeenCalledWith('req1', {
        actorTelegramId: 555,
        actorName: 'Іван Петренко',
      });
      expect(sync.renderManager).toHaveBeenCalledWith(card, cancelledView);
      expect(sync.renderGroup).toHaveBeenCalledWith(card, cancelledView);
      expect(sync.notifyManager).toHaveBeenCalledWith(cancelledView);
      expect(c.answerCbQuery).toHaveBeenCalledWith('❌ Скасовано');
    });

    it('should alert «Запит уже закрито» on 409 and redraw from finance', async () => {
      finance.cancel.mockRejectedValue(new FinanceApiError(409, 'already-closed'));
      finance.get.mockResolvedValue({ request: { ...cancelledView, status: 'accepted' } });
      const c = press();

      await service.cancel(c as never);

      expect(c.answerCbQuery).toHaveBeenCalledWith('Запит уже закрито', { show_alert: true });
      expect(sync.renderManager).toHaveBeenCalledWith(
        card,
        expect.objectContaining({ status: 'accepted' }),
      );
      expect(sync.notifyManager).not.toHaveBeenCalled();
    });

    it('should say plainly that finance did not answer, without redrawing', async () => {
      finance.cancel.mockRejectedValue(new FinanceApiError(0, 'timeout'));
      const c = press();

      await service.cancel(c as never);

      expect(c.answerCbQuery).toHaveBeenCalledWith('Фінанси не відповіли, спробуйте ще раз', {
        show_alert: true,
      });
      expect(sync.renderManager).not.toHaveBeenCalled();
    });

    it('should refuse a press from a chat that does not own the card, or from a group', async () => {
      const other = press(999);
      const group = press(-1002, 'supergroup');

      await service.cancel(other as never);
      await service.cancel(group as never);

      expect(finance.cancel).not.toHaveBeenCalled();
      expect(other.answerCbQuery).toHaveBeenCalledWith('Запит не знайдено', { show_alert: true });
    });
  });

  describe('deactivated manager', () => {
    it('should not cancel a request and should alert NOT_A_MANAGER', async () => {
      managers.findActiveByTelegramId.mockResolvedValue(null);
      const c = press();

      await service.cancel(c as never);

      expect(managers.findActiveByTelegramId).toHaveBeenCalledWith(555n);
      expect(finance.cancel).not.toHaveBeenCalled();
      expect(c.answerCbQuery).toHaveBeenCalledWith(NOT_A_MANAGER, { show_alert: true });
    });

    it('should not post a reply to finance and should answer NOT_A_MANAGER', async () => {
      managers.findActiveByTelegramId.mockResolvedValue(null);
      cards.byManagerMessage.mockResolvedValue(card);
      const c = {
        chat: { id: MANAGER_CHAT, type: 'private' },
        from: { id: 555, first_name: 'Іван' },
        text: 'ок',
        message: { message_id: 90, text: 'ок', reply_to_message: { message_id: 31 } },
        reply: jest.fn(),
        react: jest.fn(),
      };

      await service.onText(c as never, jest.fn());

      expect(finance.postMessage).not.toHaveBeenCalled();
      expect(c.reply).toHaveBeenCalledWith(NOT_A_MANAGER, expect.anything());
    });
  });

  describe('text', () => {
    const toCard = { message_id: 31, from: { id: 1 } };
    const textCtx = (text: string, replyTo?: object, type = 'private') => ({
      chat: { id: MANAGER_CHAT, type },
      from: { id: 555, first_name: 'Іван' },
      text,
      message: { message_id: 90, text, reply_to_message: replyTo },
      reply: jest.fn(),
      react: jest.fn().mockResolvedValue(true),
    });

    it('should post a reply to the manager card with a clientId and react', async () => {
      cards.byManagerMessage.mockResolvedValue(card);
      const c = textCtx('Чек надішлю завтра', toCard);
      const next = jest.fn();

      await service.onText(c as never, next);

      expect(cards.byManagerMessage).toHaveBeenCalledWith(BigInt(MANAGER_CHAT), 31);
      expect(finance.postMessage).toHaveBeenCalledWith('req1', {
        authorTelegramId: 555,
        authorName: 'Іван',
        body: 'Чек надішлю завтра',
        clientId: 'tg-555-90',
      });
      expect(c.react).toHaveBeenCalledWith('👍');
      expect(c.reply).not.toHaveBeenCalled();
      expect(next).not.toHaveBeenCalled();
    });

    it('should post a reply to a remembered «💬» message to its own request', async () => {
      cards.byManagerMessage.mockResolvedValue(null);
      cards.requestOfChatMessage.mockResolvedValue('req9');
      const c = textCtx('ок', { message_id: 40, from: { id: 1 } });

      await service.onText(c as never, jest.fn());

      expect(cards.requestOfChatMessage).toHaveBeenCalledWith(BigInt(MANAGER_CHAT), 40);
      expect(finance.postMessage).toHaveBeenCalledWith('req9', expect.anything());
    });

    it('should fall back to a reply when reactions are not available', async () => {
      cards.byManagerMessage.mockResolvedValue(card);
      const c = textCtx('ок', toCard);
      c.react.mockRejectedValue(new Error('REACTION_INVALID'));

      await service.onText(c as never, jest.fn());

      expect(c.reply).toHaveBeenCalledWith(
        'Надіслано фінансистам.',
        expect.objectContaining({ parse_mode: 'HTML' }),
      );
    });

    it('should tell the manager nothing was sent when the request is closed (409)', async () => {
      cards.byManagerMessage.mockResolvedValue(card);
      finance.postMessage.mockRejectedValue(new FinanceApiError(409, 'request-closed'));
      const c = textCtx('ок', toCard);

      await service.onText(c as never, jest.fn());

      expect(c.react).not.toHaveBeenCalled();
      expect(c.reply).toHaveBeenCalledWith(
        'Запит закрито, повідомлення не надіслано',
        expect.anything(),
      );
    });

    it('should say plainly when finance did not answer', async () => {
      cards.byManagerMessage.mockResolvedValue(card);
      finance.postMessage.mockRejectedValue(new FinanceApiError(0, 'network'));
      const c = textCtx('ок', toCard);

      await service.onText(c as never, jest.fn());

      expect(c.react).not.toHaveBeenCalled();
      expect(c.reply).toHaveBeenCalledWith(
        'Фінанси не відповіли, повідомлення не надіслано',
        expect.anything(),
      );
    });

    it('should fall through for text that is not a reply', async () => {
      const next = jest.fn();

      await service.onText(textCtx('0000-070217 4972') as never, next);

      expect(next).toHaveBeenCalled();
      expect(cards.byManagerMessage).not.toHaveBeenCalled();
      expect(finance.postMessage).not.toHaveBeenCalled();
    });

    it('should fall through for a reply to some other message, a command or a group', async () => {
      cards.byManagerMessage.mockResolvedValue(null);
      cards.requestOfChatMessage.mockResolvedValue(null);
      const next = jest.fn();

      await service.onText(textCtx('ок', { message_id: 5 }) as never, next);
      await service.onText(textCtx('/list', toCard) as never, next);
      await service.onText(textCtx('ок', toCard, 'supergroup') as never, next);

      expect(next).toHaveBeenCalledTimes(3);
      expect(finance.postMessage).not.toHaveBeenCalled();
    });
  });
});
