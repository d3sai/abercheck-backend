import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectBot } from 'nestjs-telegraf';
import { Telegraf } from 'telegraf';
import type { BotCommand, BotCommandScope, InlineKeyboardButton } from 'telegraf/types';
import type { EnvironmentVariables } from '../../../common/config/env.validation';
import { optionalNonBlank, optionalPositiveInt } from '../../../common/config/optional-config';
import { removeKeyboard } from './menu';

export type TelegramTopic = 'requests' | 'payments' | 'reports';

export interface SendOptions {
  threadId?: number;
  replyTo?: number;
}

const replyParameters = (replyTo?: number) =>
  replyTo === undefined
    ? {}
    : { reply_parameters: { message_id: replyTo, allow_sending_without_reply: true } };

@Injectable()
export class TelegramSender {
  private readonly logger = new Logger(TelegramSender.name);
  readonly adminChatId: number;
  readonly financeEnabled: boolean;
  readonly miniAppUrl: string | undefined;
  private readonly topics: Record<TelegramTopic, number | undefined>;

  constructor(
    @InjectBot() private readonly bot: Telegraf,
    config: ConfigService<EnvironmentVariables, true>,
  ) {
    this.adminChatId = config.get('TELEGRAM_ADMIN_CHAT_ID', { infer: true });
    this.financeEnabled = optionalNonBlank(config, 'FINANCE_API_URL') !== undefined;
    this.miniAppUrl = this.financeEnabled ? optionalNonBlank(config, 'MINI_APP_URL') : undefined;
    this.topics = {
      requests: optionalPositiveInt(config, 'TELEGRAM_TOPIC_REQUESTS_ID'),
      payments: optionalPositiveInt(config, 'TELEGRAM_TOPIC_PAYMENTS_ID'),
      reports: optionalPositiveInt(config, 'TELEGRAM_TOPIC_REPORTS_ID'),
    };
  }

  topicId(topic: TelegramTopic): number | undefined {
    return this.topics[topic];
  }

  async send(
    chatId: number | bigint,
    html: string,
    buttons?: InlineKeyboardButton[][],
    clearKeyboard = false,
    options: SendOptions = {},
  ): Promise<number | null> {
    try {
      const sent = await this.bot.telegram.sendMessage(Number(chatId), html, {
        parse_mode: 'HTML',
        link_preview_options: { is_disabled: true },
        reply_markup: clearKeyboard
          ? removeKeyboard
          : buttons
            ? { inline_keyboard: buttons }
            : undefined,
        ...(options.threadId === undefined ? {} : { message_thread_id: options.threadId }),
        ...replyParameters(options.replyTo),
      });
      return sent.message_id;
    } catch (error) {
      if (options.threadId !== undefined && /message thread not found/i.test(String(error))) {
        // a stale topic id must not swallow admin notices: post to the chat itself
        this.logger.warn(
          `Topic ${options.threadId} not found in chat ${chatId}, sending without it`,
        );
        return this.send(chatId, html, buttons, clearKeyboard, { ...options, threadId: undefined });
      }
      this.logger.error(`Failed to send a message to chat ${chatId}`, error);
      return null;
    }
  }

  sendToAdmins(html: string, buttons?: InlineKeyboardButton[][]): Promise<number | null> {
    return this.sendToTopic('payments', html, buttons);
  }

  sendToTopic(
    topic: TelegramTopic,
    html: string,
    buttons?: InlineKeyboardButton[][],
    options: { replyTo?: number } = {},
  ): Promise<number | null> {
    return this.send(this.adminChatId, html, buttons, false, {
      threadId: this.topics[topic],
      replyTo: options.replyTo,
    });
  }

  async editMessage(
    chatId: number | bigint,
    messageId: number,
    html: string,
    buttons?: InlineKeyboardButton[][],
  ): Promise<boolean> {
    try {
      await this.bot.telegram.editMessageText(Number(chatId), messageId, undefined, html, {
        parse_mode: 'HTML',
        link_preview_options: { is_disabled: true },
        reply_markup: buttons ? { inline_keyboard: buttons } : undefined,
      });
      return true;
    } catch (error) {
      if (error instanceof Error && /message is not modified/i.test(error.message)) return true;
      this.logger.warn(`Failed to edit message ${messageId} in chat ${chatId}`, error);
      return false;
    }
  }

  async deleteMessage(chatId: number | bigint, messageId: number): Promise<void> {
    await this.bot.telegram
      .deleteMessage(Number(chatId), messageId)
      .catch((error) =>
        this.logger.warn(`Failed to delete message ${messageId} in chat ${chatId}`, error),
      );
  }

  async sendDocument(
    chatId: number | bigint,
    file: { source: Buffer; filename: string },
    caption?: string,
    replyTo?: number,
  ): Promise<number | null> {
    try {
      const sent = await this.bot.telegram.sendDocument(Number(chatId), file, {
        caption,
        parse_mode: 'HTML',
        ...replyParameters(replyTo),
      });
      return sent.message_id;
    } catch (error) {
      this.logger.error(`Failed to send a document to chat ${chatId}`, error);
      return null;
    }
  }

  async deleteAdminMessage(messageId: number): Promise<void> {
    await this.bot.telegram
      .deleteMessage(this.adminChatId, messageId)
      .catch((error) =>
        this.logger.warn(`Failed to delete admin chat message ${messageId}`, error),
      );
  }

  /** No `chat_id`: this becomes the default menu button of every private chat; null restores the commands menu. */
  async setDefaultMenuButton(app: { text: string; url: string } | null): Promise<void> {
    try {
      await this.bot.telegram.setChatMenuButton({
        menuButton: app
          ? { type: 'web_app', text: app.text, web_app: { url: app.url } }
          : { type: 'default' },
      });
    } catch (error) {
      this.logger.warn('Failed to set the default menu button', error);
    }
  }

  async registerCommands(commands: BotCommand[], scope: BotCommandScope): Promise<void> {
    try {
      await this.bot.telegram.setMyCommands(commands, { scope });
    } catch (error) {
      this.logger.warn(`Failed to register bot commands for ${scope.type}`, error);
    }
  }
}
