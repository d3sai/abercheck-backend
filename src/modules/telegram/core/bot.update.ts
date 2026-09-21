import type { OnApplicationBootstrap } from '@nestjs/common';
import { Action, Command, Ctx, Help, Next, On, Start, Update } from 'nestjs-telegraf';
import type { Context } from 'telegraf';
import type { TelegramFileRef } from '../../attachments/attachments.service';
import { type Manager, OrderType } from '../../../generated/prisma/client';
import { ManagersService } from '../../managers/managers.service';
import { HELP, NOT_A_MANAGER, newManagerNotice, startReply } from '../access/access.messages';
import { ADMIN_HELP } from '../admin/admin.update';
import { MENU_LABEL } from './menu';
import { OrderListService } from '../orders-list/order-list.service';
import { DraftAction, OrderDraftService } from '../order-draft/order-draft.service';
import { type CommandContext, edit, fullName, isPrivate, reply } from './telegram-context';
import { TelegramSender } from './telegram-sender';

type Next = () => Promise<void>;

@Update()
export class BotUpdate implements OnApplicationBootstrap {
  constructor(
    private readonly managers: ManagersService,
    private readonly drafts: OrderDraftService,
    private readonly lists: OrderListService,
    private readonly sender: TelegramSender,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.sender.registerCommands(
      [
        { command: 'new', description: 'Формат нового замовлення' },
        { command: 'newminus', description: 'Формат закриття мінусу (без номера)' },
        { command: 'list', description: 'Мої відкриті замовлення' },
        { command: 'cancel', description: 'Забути прикріплені файли' },
        { command: 'help', description: 'Що вміє бот' },
      ],
      { type: 'all_private_chats' },
    );
    await this.sender.registerCommands(
      [
        { command: 'list', description: 'Відкриті замовлення й невідомі платежі' },
        { command: 'refund', description: 'Повернення або скасування: /refund 0000-066717' },
        { command: 'attach', description: "Прив'язати платіж: /attach 15 0000-066717" },
        { command: 'report', description: 'Звіт за вчора (/report today — за сьогодні)' },
        { command: 'help', description: 'Команди адміністратора' },
      ],
      { type: 'chat', chat_id: this.sender.adminChatId },
    );
  }

  @Start()
  async start(@Ctx() ctx: Context): Promise<void> {
    if (!isPrivate(ctx) || !ctx.from) {
      return;
    }
    const { manager, isNew } = await this.managers.requestAccess({
      telegramId: BigInt(ctx.from.id),
      name: fullName(ctx),
      username: ctx.from.username ?? null,
    });
    if (isNew) {
      await this.sender.sendToAdmins(newManagerNotice(manager));
    }
    await reply(ctx, startReply(manager));
  }

  @Help()
  async help(@Ctx() ctx: Context): Promise<void> {
    if (ctx.chat?.id === this.sender.adminChatId) {
      await reply(ctx, { html: ADMIN_HELP });
    } else if (isPrivate(ctx)) {
      await reply(ctx, { html: HELP, menu: true });
    }
  }

  @Command('chatid')
  async chatId(@Ctx() ctx: Context): Promise<void> {
    if (ctx.chat) {
      await reply(ctx, { html: `ID цього чату: <code>${ctx.chat.id}</code>` });
    }
  }

  @Command('list')
  async list(@Ctx() ctx: CommandContext): Promise<void> {
    const all = ctx.payload?.trim().toLowerCase() === 'all';
    if (ctx.chat?.id === this.sender.adminChatId) {
      await reply(ctx, await this.lists.forAdmins(all));
      return;
    }
    const manager = await this.activeManager(ctx);
    if (manager) {
      await reply(ctx, await this.lists.forManager(manager.id, all));
    }
  }

  @Command('new')
  async newOrder(@Ctx() ctx: Context): Promise<void> {
    if (await this.activeManager(ctx)) {
      await reply(ctx, this.drafts.hint(OrderType.REGULAR));
    }
  }

  @Command('newminus')
  async newMinusOrder(@Ctx() ctx: Context): Promise<void> {
    if (await this.activeManager(ctx)) {
      await reply(ctx, this.drafts.hint(OrderType.MINUS_CLOSING));
    }
  }

  @Command('cancel')
  async cancel(@Ctx() ctx: Context): Promise<void> {
    if (isPrivate(ctx) && ctx.from) {
      await reply(ctx, this.drafts.cancel(BigInt(ctx.from.id)));
    }
  }

  @Action(DraftAction.AddPart)
  async addPart(@Ctx() ctx: Context): Promise<void> {
    const manager = await this.activeManager(ctx);
    if (manager) {
      await ctx.answerCbQuery();
      await edit(ctx, await this.drafts.addPart(manager));
    }
  }

  @Action(DraftAction.SkipPart)
  async skipPart(@Ctx() ctx: Context): Promise<void> {
    if (isPrivate(ctx) && ctx.from) {
      await ctx.answerCbQuery();
      await edit(ctx, this.drafts.skipPart(BigInt(ctx.from.id)));
    }
  }

  @On('text')
  async text(@Ctx() ctx: Context, @Next() next: Next): Promise<void> {
    if (!isPrivate(ctx) || !ctx.from || !ctx.text || ctx.text.startsWith('/')) {
      return next();
    }
    switch (ctx.text) {
      case MENU_LABEL.NewOrder:
        return this.newOrder(ctx);
      case MENU_LABEL.NewMinus:
        return this.newMinusOrder(ctx);
      case MENU_LABEL.List:
        return this.list(ctx);
      case MENU_LABEL.Cancel:
        return this.cancel(ctx);
    }
    const manager = await this.activeManager(ctx);
    if (!manager) {
      return;
    }
    const answer = await this.drafts.handleText(manager, ctx.text);
    await reply(ctx, answer ?? { html: HELP, menu: true });
  }

  @On('document')
  async document(@Ctx() ctx: Context, @Next() next: Next): Promise<void> {
    const message = ctx.message;
    if (!message || !('document' in message)) {
      return next();
    }
    await this.attachFile(
      ctx,
      {
        fileId: message.document.file_id,
        filename: message.document.file_name ?? 'файл',
        mimeType: message.document.mime_type ?? 'application/octet-stream',
        size: message.document.file_size ?? 0,
        kind: 'document',
      },
      message.caption,
    );
  }

  @On('photo')
  async photo(@Ctx() ctx: Context, @Next() next: Next): Promise<void> {
    const message = ctx.message;
    if (!message || !('photo' in message)) {
      return next();
    }
    const largest = message.photo[message.photo.length - 1]!;
    await this.attachFile(
      ctx,
      {
        fileId: largest.file_id,
        filename: 'photo.jpg',
        mimeType: 'image/jpeg',
        size: largest.file_size ?? 0,
        kind: 'photo',
      },
      message.caption,
    );
  }

  private async attachFile(ctx: Context, file: TelegramFileRef, caption?: string): Promise<void> {
    const manager = await this.activeManager(ctx);
    if (!manager) {
      return;
    }
    await reply(ctx, await this.drafts.addFile(manager, file, caption));
  }

  private async activeManager(ctx: Context): Promise<Manager | null> {
    if (!isPrivate(ctx) || !ctx.from) {
      return null;
    }
    const manager = await this.managers.findActiveByTelegramId(BigInt(ctx.from.id));
    if (!manager) {
      await reply(ctx, { html: NOT_A_MANAGER });
    }
    return manager;
  }
}
