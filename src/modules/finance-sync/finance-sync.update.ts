import { Action, Command, Ctx, Next, On, Update } from 'nestjs-telegraf';
import type { Context } from 'telegraf';
import { MENU_LABEL } from '../telegram/core/menu';
import { isPrivate, type MatchContext } from '../telegram/core/telegram-context';
import { FinancierActionsService } from './financier-actions.service';
import { ManagerActionsService } from './manager-actions.service';
import { FinanceAction } from './request-card.messages';
import { RequestReceiptsService } from './request-receipts.service';

@Update()
export class FinanceSyncUpdate {
  constructor(
    private readonly actions: FinancierActionsService,
    private readonly managerActions: ManagerActionsService,
    private readonly receipts: RequestReceiptsService,
  ) {}

  @Action(FinanceAction.Fop)
  fop(@Ctx() ctx: MatchContext): Promise<void> {
    return this.actions.pressFop(ctx);
  }

  @Action(FinanceAction.Refresh)
  refresh(@Ctx() ctx: MatchContext): Promise<void> {
    return this.actions.refresh(ctx);
  }

  @Action(FinanceAction.Cancel)
  cancel(@Ctx() ctx: MatchContext): Promise<void> {
    return this.managerActions.cancel(ctx);
  }

  @Command('requests')
  requests(@Ctx() ctx: Context): Promise<void> {
    return this.managerActions.myRequests(ctx);
  }

  // Each handler claims only replies to its own cards and calls `next` otherwise, ending in BotUpdate.text.
  @On('text')
  text(@Ctx() ctx: Context, @Next() next: () => Promise<void>): Promise<void> {
    if (isPrivate(ctx) && ctx.text === MENU_LABEL.MyRequests)
      return this.managerActions.myRequests(ctx);
    return this.actions.onText(ctx, () => this.managerActions.onText(ctx, next));
  }

  // Files claim only replies to a manager's own request; the rest falls through to BotUpdate's order drafts.
  @On('document')
  document(@Ctx() ctx: Context, @Next() next: () => Promise<void>): Promise<void> {
    const message = ctx.message;
    if (!message || !('document' in message)) return next();
    return this.receipts.onFile(
      ctx,
      {
        fileId: message.document.file_id,
        filename: message.document.file_name ?? 'файл',
        mimeType: message.document.mime_type ?? 'application/octet-stream',
        size: message.document.file_size ?? 0,
        kind: 'document',
      },
      next,
    );
  }

  @On('photo')
  photo(@Ctx() ctx: Context, @Next() next: () => Promise<void>): Promise<void> {
    const message = ctx.message;
    if (!message || !('photo' in message)) return next();
    const largest = message.photo[message.photo.length - 1]!;
    return this.receipts.onFile(
      ctx,
      {
        fileId: largest.file_id,
        filename: 'photo.jpg',
        mimeType: 'image/jpeg',
        size: largest.file_size ?? 0,
        kind: 'photo',
      },
      next,
    );
  }
}
