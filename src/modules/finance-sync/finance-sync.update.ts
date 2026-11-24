import { Action, Ctx, Next, On, Update } from 'nestjs-telegraf';
import type { Context } from 'telegraf';
import type { MatchContext } from '../telegram/core/telegram-context';
import { FinancierActionsService } from './financier-actions.service';
import { ManagerActionsService } from './manager-actions.service';
import { OrderAttachAction } from '../telegram/orders-list/orders-list.messages';
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

  @Action(FinanceAction.Route)
  route(@Ctx() ctx: MatchContext): Promise<void> {
    return this.receipts.onChoice(ctx);
  }

  @Action(FinanceAction.Payment)
  payment(@Ctx() ctx: MatchContext): Promise<void> {
    return this.receipts.onPayment(ctx);
  }

  @Action(FinanceAction.Attach)
  attach(@Ctx() ctx: MatchContext): Promise<void> {
    return this.managerActions.askFiles(ctx);
  }

  @Action(OrderAttachAction)
  attachOrder(@Ctx() ctx: MatchContext): Promise<void> {
    return this.receipts.askOrderFiles(ctx);
  }

  @Action(FinanceAction.Cancel)
  cancel(@Ctx() ctx: MatchContext): Promise<void> {
    return this.managerActions.cancel(ctx);
  }

  // Each handler claims only replies to its own cards and calls `next` otherwise, ending in BotUpdate.text.
  @On('text')
  text(@Ctx() ctx: Context, @Next() next: () => Promise<void>): Promise<void> {
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
