import type { ConfigService } from '@nestjs/config';
import type { Telegraf } from 'telegraf';
import type { EnvironmentVariables } from '../../../../src/common/config/env.validation';
import { TelegramSender } from '../../../../src/modules/telegram/core/telegram-sender';

const ADMIN_CHAT_ID = -1002286861249;

type SendArgs = [number, string, { reply_markup?: { keyboard?: unknown } }];

describe('TelegramSender', () => {
  const bot = {
    telegram: {
      sendMessage: jest.fn<Promise<unknown>, SendArgs>(),
      setMyCommands: jest.fn(),
    },
  };
  const config = { get: () => ADMIN_CHAT_ID } as unknown as ConfigService<
    EnvironmentVariables,
    true
  >;
  let sender: TelegramSender;

  beforeEach(() => {
    sender = new TelegramSender(bot as unknown as Telegraf, config);
  });

  afterEach(() => jest.resetAllMocks());

  describe('send', () => {
    it('should send plain HTML with no keyboard by default', async () => {
      bot.telegram.sendMessage.mockResolvedValue({});

      const ok = await sender.send(5000000000n, '<b>Привіт</b>');

      expect(ok).toBe(true);
      expect(bot.telegram.sendMessage).toHaveBeenCalledWith(5000000000, '<b>Привіт</b>', {
        parse_mode: 'HTML',
        link_preview_options: { is_disabled: true },
        reply_markup: undefined,
      });
    });

    it('should attach inline buttons when given', async () => {
      bot.telegram.sendMessage.mockResolvedValue({});
      const buttons = [[{ text: 'OK', callback_data: 'ok' }]];

      await sender.send(111, 'text', buttons);

      expect(bot.telegram.sendMessage).toHaveBeenCalledWith(
        111,
        'text',
        expect.objectContaining({ reply_markup: { inline_keyboard: buttons } }),
      );
    });

    it('should attach the persistent menu keyboard instead of buttons when menu is true', async () => {
      bot.telegram.sendMessage.mockResolvedValue({});
      const buttons = [[{ text: 'OK', callback_data: 'ok' }]];

      await sender.send(111, 'text', buttons, true);

      const [, , options] = bot.telegram.sendMessage.mock.calls[0]!;
      expect(options.reply_markup).not.toEqual({ inline_keyboard: buttons });
      expect(options.reply_markup).toHaveProperty('keyboard');
    });

    it('should convert a bigint chat id to a number for the Telegram API', async () => {
      bot.telegram.sendMessage.mockResolvedValue({});

      await sender.send(5000000000n, 'text');

      expect(bot.telegram.sendMessage).toHaveBeenCalledWith(5000000000, 'text', expect.anything());
    });

    it('should swallow a failed send and report it as false instead of throwing', async () => {
      bot.telegram.sendMessage.mockRejectedValue(new Error('bot was blocked by the user'));

      await expect(sender.send(111, 'text')).resolves.toBe(false);
    });
  });

  describe('sendToAdmins', () => {
    it('should send to the configured admin chat id', async () => {
      bot.telegram.sendMessage.mockResolvedValue({});

      await sender.sendToAdmins('text');

      expect(bot.telegram.sendMessage).toHaveBeenCalledWith(
        ADMIN_CHAT_ID,
        'text',
        expect.anything(),
      );
    });

    it('should also swallow failures for admin messages', async () => {
      bot.telegram.sendMessage.mockRejectedValue(new Error('down'));

      await expect(sender.sendToAdmins('text')).resolves.toBe(false);
    });
  });

  describe('registerCommands', () => {
    it('should register the given commands for the given scope', async () => {
      bot.telegram.setMyCommands.mockResolvedValue(true);
      const commands = [{ command: 'new', description: 'Формат нового замовлення' }];

      await sender.registerCommands(commands, { type: 'all_private_chats' });

      expect(bot.telegram.setMyCommands).toHaveBeenCalledWith(commands, {
        scope: { type: 'all_private_chats' },
      });
    });

    it('should not throw when Telegram rejects the command registration', async () => {
      bot.telegram.setMyCommands.mockRejectedValue(new Error('bad request'));

      await expect(
        sender.registerCommands([], { type: 'all_private_chats' }),
      ).resolves.toBeUndefined();
    });
  });
});
