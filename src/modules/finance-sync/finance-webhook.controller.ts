import {
  BadRequestException,
  Body,
  Controller,
  HttpCode,
  Post,
  UseGuards,
  VERSION_NEUTRAL,
} from '@nestjs/common';
import type { FinanceEvent } from './finance.types';
import { FinanceWebhookGuard } from './finance-webhook.guard';
import { RequestSyncService } from './request-sync.service';

// VERSION_NEUTRAL: finance is configured with the plain /api/finance/webhook, without /v1
@Controller({ path: 'finance', version: VERSION_NEUTRAL })
@UseGuards(FinanceWebhookGuard)
export class FinanceWebhookController {
  constructor(private readonly sync: RequestSyncService) {}

  /** Awaited on purpose: an error becomes a 500, so finance retries the event. */
  @Post('webhook')
  @HttpCode(200)
  async receive(@Body() event: FinanceEvent): Promise<{ ok: true }> {
    if (typeof event?.requestId !== 'string') throw new BadRequestException();
    await this.sync.handle(event);
    return { ok: true };
  }
}
