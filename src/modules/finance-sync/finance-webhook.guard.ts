import {
  CanActivate,
  ExecutionContext,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request } from 'express';
import { timingSafeEqual } from 'node:crypto';
import { optionalNonBlank } from '../../common/config/optional-config';
import { digest } from '../../common/guards/api-key.guard';

@Injectable()
export class FinanceWebhookGuard implements CanActivate {
  constructor(private readonly config: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const token = optionalNonBlank(this.config, 'FINANCE_WEBHOOK_TOKEN');
    // disabled finance must look like a missing route, not like a guarded one
    if (!optionalNonBlank(this.config, 'FINANCE_API_URL') || !token) throw new NotFoundException();

    const provided = context.switchToHttp().getRequest<Request>().header('x-api-token');
    if (!provided || !timingSafeEqual(digest(provided), digest(token))) {
      throw new UnauthorizedException('Invalid API token');
    }
    return true;
  }
}
