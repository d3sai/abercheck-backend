import {
  type CanActivate,
  createParamDecorator,
  type ExecutionContext,
  HttpStatus,
  Injectable,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Manager } from '../../generated/prisma/client';
import { ApiError } from '../../common/api-error';
import type { EnvironmentVariables } from '../../common/config/env.validation';
import type { AuthenticatedRequest } from '../auth/auth.decorators';
import { ManagersService } from '../managers/managers.service';
import { verifyInitData } from './init-data';

export const MINIAPP_INIT_DATA_HEADER = 'x-telegram-init-data';

@Injectable()
export class MiniappAuthGuard implements CanActivate {
  constructor(
    private readonly config: ConfigService<EnvironmentVariables, true>,
    private readonly managers: ManagersService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const raw = request.header(MINIAPP_INIT_DATA_HEADER);
    const result = raw
      ? verifyInitData(raw, this.config.get('TELEGRAM_BOT_TOKEN', { infer: true }), new Date())
      : null;
    if (!result?.ok) {
      throw new ApiError(HttpStatus.UNAUTHORIZED, 'init-data-invalid', 'Недійсні дані Telegram');
    }

    const manager = await this.managers.findActiveByTelegramId(result.telegramId);
    if (!manager) {
      throw new ApiError(HttpStatus.FORBIDDEN, 'not-a-manager', 'Доступ лише для менеджерів');
    }
    request.manager = manager;
    return true;
  }
}

export const MiniappManager = createParamDecorator(
  (_data: unknown, context: ExecutionContext): Manager =>
    context.switchToHttp().getRequest<AuthenticatedRequest>().manager,
);
