import { Action, Command, Ctx, Next, On, Update } from 'nestjs-telegraf';
import type { Context } from 'telegraf';
import { ManagersService } from '../managers/managers.service';
import { NOT_A_MANAGER } from '../telegram/access/access.messages';
import {
  type CommandContext,
  isPrivate,
  type MatchContext,
  reply,
} from '../telegram/core/telegram-context';
import { FinancierActionsService } from './financier-actions.service';
import { ManagerActionsService } from './manager-actions.service';
import { FinanceAction } from './request-card.messages';
import { RequestCreateService } from './request-create.service';

// shortcut: temporary command, delete it when the Part 3 Mini App replaces it.
@Update()
export class FinanceSyncUpdate {
  constructor(
    private readonly managers: ManagersService,
    private readonly requests: RequestCreateService,
    private readonly actions: FinancierActionsService,
    private readonly managerActions: ManagerActionsService,
  ) {}

  @Command('testrequest')
  async testRequest(@Ctx() ctx: CommandContext & Context): Promise<void> {
    if (!isPrivate(ctx) || !ctx.from) return;
    const manager = await this.managers.findActiveByTelegramId(BigInt(ctx.from.id));
    if (!manager) {
      await reply(ctx, { html: NOT_A_MANAGER });
      return;
    }
    const answer = await this.requests.handle(manager, ctx.payload ?? '');
    if (answer) await reply(ctx, answer);
  }

  @Action(FinanceAction.Fop)
  fop(@Ctx() ctx: MatchContext): Promise<void> {
    return this.actions.pressFop(ctx);
  }

  @Action(FinanceAction.Rate)
  rate(@Ctx() ctx: MatchContext): Promise<void> {
    return this.actions.askRate(ctx);
  }

  @Action(FinanceAction.Refresh)
  refresh(@Ctx() ctx: MatchContext): Promise<void> {
    return this.actions.refresh(ctx);
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
}
