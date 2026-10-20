import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectBot } from 'nestjs-telegraf';
import { Telegraf } from 'telegraf';
import type { BotCommand, BotCommandScope, InlineKeyboardButton } from 'telegraf/types';
import type { EnvironmentVariables } from '../../../common/config/env.validation';
import { mainMenuKeyboard } from './menu';

@Injectable()
export class TelegramSender {
  private readonly logger = new Logger(TelegramSender.name);
  readonly adminChatId: number;

  constructor(
    @InjectBot() private readonly bot: Telegraf,
    config: ConfigService<EnvironmentVariables, true>,
  ) {
    this.adminChatId = config.get('TELEGRAM_ADMIN_CHAT_ID', { infer: true });
  }

  async send(
    chatId: number | bigint,
    html: string,
    buttons?: InlineKeyboardButton[][],
    menu = false,
  ): Promise<number | null> {
    try {
      const sent = await this.bot.telegram.sendMessage(Number(chatId), html, {
        parse_mode: 'HTML',
        link_preview_options: { is_disabled: true },
        reply_markup: menu ? mainMenuKeyboard : buttons ? { inline_keyboard: buttons } : undefined,
      });
      return sent.message_id;
    } catch (error) {
      this.logger.error(`Failed to send a message to chat ${chatId}`, error);
      return null;
    }
  }

  sendToAdmins(html: string, buttons?: InlineKeyboardButton[][]): Promise<number | null> {
    return this.send(this.adminChatId, html, buttons);
  }

  async deleteAdminMessage(messageId: number): Promise<void> {
    await this.bot.telegram
      .deleteMessage(this.adminChatId, messageId)
      .catch((error) =>
        this.logger.warn(`Failed to delete admin chat message ${messageId}`, error),
      );
  }

  async registerCommands(commands: BotCommand[], scope: BotCommandScope): Promise<void> {
    try {
      await this.bot.telegram.setMyCommands(commands, { scope });
    } catch (error) {
      this.logger.warn(`Failed to register bot commands for ${scope.type}`, error);
    }
  }
}
