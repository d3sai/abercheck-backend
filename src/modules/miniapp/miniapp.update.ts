import { Logger } from '@nestjs/common';
import { Action, Ctx, Update } from 'nestjs-telegraf';
import { ApiError, type ApiErrorBody } from '../../common/api-error';
import { FinanceAction } from '../finance-sync/request-card.messages';
import { ManagersService } from '../managers/managers.service';
import { NOT_A_MANAGER } from '../telegram/access/access.messages';
import { isPrivate, type MatchContext } from '../telegram/core/telegram-context';
import { RequestCompletionService } from './request-completion.service';

// Telegram caps an alert at 200 characters
const alert = (text: string) => [text.slice(0, 200), { show_alert: true }] as const;

const PART_HINT = ' Відкрийте «✏️ Змінити».';

/** Manager card buttons that create orders: here, not in finance-sync, because completion lives in this module. */
@Update()
export class MiniappUpdate {
  private readonly logger = new Logger(MiniappUpdate.name);

  constructor(
    private readonly completion: RequestCompletionService,
    private readonly managers: ManagersService,
  ) {}

  /** «✅ Прийняти»: the card redraws itself on success; the press only needs an answer. */
  @Action(FinanceAction.Accept)
  async accept(@Ctx() ctx: MatchContext): Promise<void> {
    if (!isPrivate(ctx) || !ctx.from) return;
    const manager = await this.managers.findActiveByTelegramId(BigInt(ctx.from.id));
    if (!manager) {
      await ctx.answerCbQuery(...alert(NOT_A_MANAGER));
      return;
    }
    try {
      const result = await this.completion.accept(manager, ctx.match[1]!);
      await (result.note
        ? ctx.answerCbQuery(...alert(result.note))
        : ctx.answerCbQuery('✅ Оформлено'));
    } catch (error) {
      if (!(error instanceof ApiError)) {
        this.logger.error(`Accepting ${ctx.match[1]} failed`, error);
        await ctx.answerCbQuery(...alert('Не вдалося, спробуйте ще раз'));
        return;
      }
      const { code, message } = error.getResponse() as ApiErrorBody;
      await ctx.answerCbQuery(
        ...alert(code === 'order-exists-part' ? message + PART_HINT : message),
      );
    }
  }
}
