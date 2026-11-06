import { Logger } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import type { Telegraf } from 'telegraf';
import {
  validateEnv,
  type EnvironmentVariables,
} from '../../../../src/common/config/env.validation';
import { TelegramSender } from '../../../../src/modules/telegram/core/telegram-sender';

const ADMIN_CHAT_ID = -1002286861249;

type SendArgs = [number, string, { reply_markup?: { keyboard?: unknown } }];

describe('TelegramSender', () => {
  const bot = {
    telegram: {
      sendMessage: jest.fn<Promise<unknown>, SendArgs>(),
      sendDocument: jest.fn(),
      editMessageText: jest.fn(),
      deleteMessage: jest.fn(),
      setMyCommands: jest.fn(),
      setChatMenuButton: jest.fn(),
    },
  };
  let env: Partial<EnvironmentVariables>;
  let sender: TelegramSender;

  beforeEach(() => {
    env = { TELEGRAM_ADMIN_CHAT_ID: ADMIN_CHAT_ID };
    const config = {
      get: (key: keyof EnvironmentVariables) => env[key],
    } as unknown as ConfigService<EnvironmentVariables, true>;
    sender = new TelegramSender(bot as unknown as Telegraf, config);
  });

  afterEach(() => jest.resetAllMocks());

  const rebuild = () =>
    new TelegramSender(
      bot as unknown as Telegraf,
      {
        get: (key: keyof EnvironmentVariables) => env[key],
      } as unknown as ConfigService<EnvironmentVariables, true>,
    );

  describe('send', () => {
    it('should send plain HTML with no keyboard by default', async () => {
      bot.telegram.sendMessage.mockResolvedValue({ message_id: 42 });

      const messageId = await sender.send(5000000000n, '<b>Привіт</b>');

      expect(messageId).toBe(42);
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

    it('should remove the old reply keyboard instead of attaching buttons when the flag is set', async () => {
      bot.telegram.sendMessage.mockResolvedValue({});
      const buttons = [[{ text: 'OK', callback_data: 'ok' }]];

      await sender.send(111, 'text', buttons, true);

      const [, , options] = bot.telegram.sendMessage.mock.calls[0]!;
      expect(options.reply_markup).toEqual({ remove_keyboard: true });
    });

    it('should convert a bigint chat id to a number for the Telegram API', async () => {
      bot.telegram.sendMessage.mockResolvedValue({});

      await sender.send(5000000000n, 'text');

      expect(bot.telegram.sendMessage).toHaveBeenCalledWith(5000000000, 'text', expect.anything());
    });

    it('should swallow a failed send and report it as null instead of throwing', async () => {
      bot.telegram.sendMessage.mockRejectedValue(new Error('bot was blocked by the user'));

      await expect(sender.send(111, 'text')).resolves.toBeNull();
    });
  });

  describe('a topic that no longer exists', () => {
    it('should retry once without the thread, keep the reply target and warn naming the topic', async () => {
      const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
      bot.telegram.sendMessage
        .mockRejectedValueOnce(new Error('400: Bad Request: message thread not found'))
        .mockResolvedValueOnce({ message_id: 9 });

      const id = await sender.send(111, 'text', undefined, false, { threadId: 5, replyTo: 3 });

      expect(id).toBe(9);
      expect(bot.telegram.sendMessage).toHaveBeenCalledTimes(2);
      const retry = bot.telegram.sendMessage.mock.calls[1]![2];
      expect(retry).not.toHaveProperty('message_thread_id');
      expect(retry).toHaveProperty('reply_parameters.message_id', 3);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('5'));
      warn.mockRestore();
    });

    it('should not retry without a thread, nor for another error', async () => {
      bot.telegram.sendMessage.mockRejectedValue(
        new Error('400: Bad Request: message thread not found'),
      );
      await expect(sender.send(111, 'text')).resolves.toBeNull();
      expect(bot.telegram.sendMessage).toHaveBeenCalledTimes(1);

      bot.telegram.sendMessage.mockClear();
      bot.telegram.sendMessage.mockRejectedValue(new Error('403: Forbidden: bot was blocked'));
      await expect(sender.send(111, 'text', undefined, false, { threadId: 5 })).resolves.toBeNull();
      expect(bot.telegram.sendMessage).toHaveBeenCalledTimes(1);
    });

    it('should report null when the retry fails too, without a third attempt', async () => {
      bot.telegram.sendMessage.mockRejectedValue(
        new Error('400: Bad Request: message thread not found'),
      );

      await expect(sender.send(111, 'text', undefined, false, { threadId: 5 })).resolves.toBeNull();
      expect(bot.telegram.sendMessage).toHaveBeenCalledTimes(2);
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

    it('should post into the payments topic when it is configured', async () => {
      env.TELEGRAM_TOPIC_PAYMENTS_ID = 7;
      sender = rebuild();
      bot.telegram.sendMessage.mockResolvedValue({});

      await sender.sendToAdmins('text');

      expect(bot.telegram.sendMessage).toHaveBeenCalledWith(
        ADMIN_CHAT_ID,
        'text',
        expect.objectContaining({ message_thread_id: 7 }),
      );
    });

    it('should not set message_thread_id when the payments topic is unset', async () => {
      bot.telegram.sendMessage.mockResolvedValue({});

      await sender.sendToAdmins('text');

      const [, , options] = bot.telegram.sendMessage.mock.calls[0]!;
      expect(options).not.toHaveProperty('message_thread_id');
      expect(options).not.toHaveProperty('reply_parameters');
    });

    it('should also swallow failures for admin messages', async () => {
      bot.telegram.sendMessage.mockRejectedValue(new Error('down'));

      await expect(sender.sendToAdmins('text')).resolves.toBeNull();
    });
  });

  describe('send options', () => {
    it('should pass the thread id and reply target', async () => {
      bot.telegram.sendMessage.mockResolvedValue({});

      await sender.send(111, 'text', undefined, false, { threadId: 5, replyTo: 9 });

      expect(bot.telegram.sendMessage).toHaveBeenCalledWith(
        111,
        'text',
        expect.objectContaining({
          message_thread_id: 5,
          reply_parameters: { message_id: 9, allow_sending_without_reply: true },
        }),
      );
    });
  });

  describe('sendToTopic', () => {
    it('should send to the admin chat in the requested topic', async () => {
      env.TELEGRAM_TOPIC_REQUESTS_ID = 11;
      env.TELEGRAM_TOPIC_REPORTS_ID = 13;
      sender = rebuild();
      bot.telegram.sendMessage.mockResolvedValue({ message_id: 3 });

      await expect(sender.sendToTopic('requests', 'card', undefined, { replyTo: 2 })).resolves.toBe(
        3,
      );

      expect(bot.telegram.sendMessage).toHaveBeenCalledWith(
        ADMIN_CHAT_ID,
        'card',
        expect.objectContaining({
          message_thread_id: 11,
          reply_parameters: { message_id: 2, allow_sending_without_reply: true },
        }),
      );
      expect(sender.topicId('reports')).toBe(13);
      expect(sender.topicId('payments')).toBeUndefined();
    });

    it('should fall back to the plain chat when the topic is unset', async () => {
      bot.telegram.sendMessage.mockResolvedValue({});

      await sender.sendToTopic('reports', 'text');

      const [chatId, , options] = bot.telegram.sendMessage.mock.calls[0]!;
      expect(chatId).toBe(ADMIN_CHAT_ID);
      expect(options).not.toHaveProperty('message_thread_id');
    });
  });

  describe('blank env values loaded through the real ConfigModule', () => {
    const blankVars = {
      DATABASE_URL: 'postgresql://user:pass@db.example.com:5432/app?schema=public',
      EXTERNAL_API_KEY: 'k'.repeat(32),
      TELEGRAM_BOT_TOKEN: `123456789:${'A'.repeat(35)}`,
      TELEGRAM_ADMIN_CHAT_ID: String(ADMIN_CHAT_ID),
      WEB_JWT_SECRET: 's'.repeat(32),
      TELEGRAM_TOPIC_REQUESTS_ID: '',
      TELEGRAM_TOPIC_PAYMENTS_ID: '  ',
      TELEGRAM_TOPIC_REPORTS_ID: '',
      FINANCE_API_URL: '',
    };
    const saved = { ...process.env };

    afterEach(() => {
      process.env = { ...saved };
    });

    it('should send no message_thread_id and keep finance off', async () => {
      Object.assign(process.env, blankVars);
      const moduleRef = await Test.createTestingModule({
        imports: [ConfigModule.forRoot({ validate: validateEnv, ignoreEnvFile: true })],
      }).compile();
      const real = new TelegramSender(
        bot as unknown as Telegraf,
        moduleRef.get<ConfigService<EnvironmentVariables, true>>(ConfigService),
      );
      bot.telegram.sendMessage.mockResolvedValue({});

      await real.sendToAdmins('a');
      await real.sendToTopic('requests', 'b');
      await real.sendToTopic('reports', 'c');

      for (const [, , options] of bot.telegram.sendMessage.mock.calls) {
        expect(options).not.toHaveProperty('message_thread_id');
      }
      expect(bot.telegram.sendMessage).toHaveBeenCalledTimes(3);
      expect(real.financeEnabled).toBe(false);
    });
  });

  describe('financeEnabled', () => {
    it('should follow FINANCE_API_URL', () => {
      expect(sender.financeEnabled).toBe(false);
      env.FINANCE_API_URL = 'http://finance.local';
      expect(rebuild().financeEnabled).toBe(true);
    });
  });

  describe('miniAppUrl', () => {
    it('should follow MINI_APP_URL only while finance is enabled, treating blank as unset', () => {
      expect(sender.miniAppUrl).toBeUndefined();
      env.MINI_APP_URL = 'https://cab.example.ua/tg/request';
      expect(rebuild().miniAppUrl).toBeUndefined();
      env.FINANCE_API_URL = 'http://finance.local';
      expect(rebuild().miniAppUrl).toBe('https://cab.example.ua/tg/request');
      env.MINI_APP_URL = '  ';
      expect(rebuild().miniAppUrl).toBeUndefined();
    });

    it('should never attach a reply keyboard, with or without the Mini App configured', async () => {
      bot.telegram.sendMessage.mockResolvedValue({});
      env.FINANCE_API_URL = 'http://finance.local';
      env.MINI_APP_URL = 'https://cab.example.ua/tg/request';

      await rebuild().send(111, 'text', undefined, true);

      const options = bot.telegram.sendMessage.mock.calls[0]?.[2];
      expect(options?.reply_markup).toEqual({ remove_keyboard: true });
    });
  });

  describe('setDefaultMenuButton', () => {
    it('should set a web_app menu button for every chat', async () => {
      await sender.setDefaultMenuButton({
        text: '📝 Новий запит',
        url: 'https://cab.example.ua/tg/request',
      });

      expect(bot.telegram.setChatMenuButton).toHaveBeenCalledWith({
        menuButton: {
          type: 'web_app',
          text: '📝 Новий запит',
          web_app: { url: 'https://cab.example.ua/tg/request' },
        },
      });
    });

    it('should restore the default commands menu for null', async () => {
      await sender.setDefaultMenuButton(null);

      expect(bot.telegram.setChatMenuButton).toHaveBeenCalledWith({
        menuButton: { type: 'default' },
      });
    });

    it('should log and swallow a Telegram failure', async () => {
      bot.telegram.setChatMenuButton.mockRejectedValue(new Error('boom'));
      jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

      await expect(sender.setDefaultMenuButton(null)).resolves.toBeUndefined();
    });
  });

  describe('editMessage', () => {
    it('should edit text and buttons and report success', async () => {
      bot.telegram.editMessageText.mockResolvedValue(true);
      const buttons = [[{ text: 'OK', callback_data: 'ok' }]];

      await expect(sender.editMessage(5, 8, 'new', buttons)).resolves.toBe(true);

      expect(bot.telegram.editMessageText).toHaveBeenCalledWith(5, 8, undefined, 'new', {
        parse_mode: 'HTML',
        link_preview_options: { is_disabled: true },
        reply_markup: { inline_keyboard: buttons },
      });
    });

    it('should count "message is not modified" as success', async () => {
      bot.telegram.editMessageText.mockRejectedValue(
        new Error('400: Bad Request: message is not modified: specified new message content'),
      );

      await expect(sender.editMessage(5, 8, 'same')).resolves.toBe(true);
    });

    it('should report any other failure as false', async () => {
      bot.telegram.editMessageText.mockRejectedValue(new Error('message to edit not found'));

      await expect(sender.editMessage(5, 8, 'x')).resolves.toBe(false);
    });
  });

  describe('deleteMessage', () => {
    it('should delete in the given chat and swallow failures', async () => {
      bot.telegram.deleteMessage.mockRejectedValue(new Error('too old'));

      await expect(sender.deleteMessage(5, 8)).resolves.toBeUndefined();
      expect(bot.telegram.deleteMessage).toHaveBeenCalledWith(5, 8);
    });
  });

  describe('sendDocument', () => {
    it('should upload the buffer with caption and reply target', async () => {
      bot.telegram.sendDocument.mockResolvedValue({ message_id: 4 });
      const file = { source: Buffer.from('x'), filename: 'a.pdf' };

      await expect(sender.sendDocument(5, file, 'cap', 9)).resolves.toBe(4);

      expect(bot.telegram.sendDocument).toHaveBeenCalledWith(5, file, {
        caption: 'cap',
        parse_mode: 'HTML',
        reply_parameters: { message_id: 9, allow_sending_without_reply: true },
      });
    });

    it('should report a failed upload as null', async () => {
      bot.telegram.sendDocument.mockRejectedValue(new Error('down'));

      await expect(
        sender.sendDocument(5, { source: Buffer.from('x'), filename: 'a.pdf' }),
      ).resolves.toBeNull();
    });
  });

  describe('deleteAdminMessage', () => {
    it('should delete the message in the admin chat', async () => {
      bot.telegram.deleteMessage.mockResolvedValue(true);

      await sender.deleteAdminMessage(77);

      expect(bot.telegram.deleteMessage).toHaveBeenCalledWith(ADMIN_CHAT_ID, 77);
    });

    it('should not throw when Telegram refuses (e.g. the message is too old)', async () => {
      bot.telegram.deleteMessage.mockRejectedValue(new Error('message can not be deleted'));

      await expect(sender.deleteAdminMessage(77)).resolves.toBeUndefined();
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
