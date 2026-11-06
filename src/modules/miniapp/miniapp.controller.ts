import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Logger,
  Param,
  Post,
  UploadedFiles,
  UseFilters,
  UseGuards,
  UseInterceptors,
  VERSION_NEUTRAL,
} from '@nestjs/common';
import { FilesInterceptor } from '@nestjs/platform-express';
import type { FinanceRequestCard, Manager } from '../../generated/prisma/client';
import {
  attachmentUploadOptions,
  MAX_FILES_PER_UPLOAD,
} from '../attachments/attachments.constants';
import { DomainErrorFilter } from '../cabinet/controllers/domain-error.filter';
import { ApiError } from '../../common/api-error';
import { kyivDate, kyivParts } from '../../common/kyiv-time';
import { FinanceClient } from '../finance-sync/finance.client';
import { type FinanceRequestView, paysAfterConfirm } from '../finance-sync/finance.types';
import { RequestCardsRepository } from '../finance-sync/request-cards.repository';
import { RequestCreateService } from '../finance-sync/request-create.service';
import { RequestSyncService } from '../finance-sync/request-sync.service';
import { type StoredPayment, storedPayments } from '../finance-sync/stored-payments';
import { type DirectOrdersResult, DirectOrdersService } from './direct-orders.service';
import { MiniappManager, MiniappAuthGuard } from './miniapp-auth.guard';
import {
  CompleteMiniappRequestDto,
  CreateMiniappOrderDto,
  CreateMiniappRequestDto,
  EditMiniappRequestDto,
  PaidMiniappRequestDto,
  toCreateInput,
  toEditBody,
  toEditPayments,
  toOrderPlan,
} from './miniapp.dto';
import { financeError, notFound } from './miniapp.errors';
import { type CompletionResult, RequestCompletionService } from './request-completion.service';

interface RequestResponse {
  request: FinanceRequestView;
  managerName: string;
  completed: boolean;
  /** Nothing is left to do: set with the completion, or by «💰 Оплачено» for our_fop and foreign_fop. */
  closed: boolean;
  /** The payments given at creation; Kyiv date and time. */
  payments: {
    payerName: string | null;
    account: string | null;
    amount: string;
    date: string;
    time: string;
  }[];
}

const CREATE_STATUS = {
  'not-created': HttpStatus.UNPROCESSABLE_ENTITY,
  unknown: HttpStatus.BAD_GATEWAY,
  disabled: HttpStatus.SERVICE_UNAVAILABLE,
} as const;

// VERSION_NEUTRAL: the Mini App calls the plain /api/miniapp, without /v1
@Controller({ path: 'miniapp', version: VERSION_NEUTRAL })
@UseGuards(MiniappAuthGuard)
export class MiniappController {
  private readonly logger = new Logger(MiniappController.name);

  constructor(
    private readonly requests: RequestCreateService,
    private readonly finance: FinanceClient,
    private readonly cards: RequestCardsRepository,
    private readonly sync: RequestSyncService,
    private readonly completion: RequestCompletionService,
    private readonly directOrders: DirectOrdersService,
  ) {}

  @Post('requests')
  @HttpCode(HttpStatus.OK)
  async create(
    @MiniappManager() manager: Manager,
    @Body() dto: CreateMiniappRequestDto,
  ): Promise<{ requestId: string; number: string; message?: string }> {
    const result = await this.requests.create(manager, toCreateInput(dto));
    if (!result.ok) {
      const status =
        result.code === 'order-taken' ? HttpStatus.CONFLICT : CREATE_STATUS[result.outcome];
      throw new ApiError(status, result.code, result.message);
    }
    return {
      requestId: result.requestId,
      number: result.number,
      ...(result.note && { message: result.note }),
    };
  }

  /** Kit, cash and foreign payments: orders and notices without a request to the financiers. */
  @Post('orders')
  async createOrders(
    @MiniappManager() manager: Manager,
    @Body() dto: CreateMiniappOrderDto,
  ): Promise<DirectOrdersResult> {
    return this.directOrders.create(manager, toOrderPlan(dto));
  }

  @Get('requests/:id')
  async get(@MiniappManager() manager: Manager, @Param('id') id: string): Promise<RequestResponse> {
    const card = await this.ownCard(manager, id);
    try {
      return this.response(manager, card, (await this.finance.get(id)).request);
    } catch (error) {
      throw financeError(error);
    }
  }

  @Post('requests/:id/edit')
  @HttpCode(HttpStatus.OK)
  async edit(
    @MiniappManager() manager: Manager,
    @Param('id') id: string,
    @Body() dto: EditMiniappRequestDto,
  ): Promise<RequestResponse> {
    let card = await this.ownCard(manager, id);
    const body = toEditBody(dto, Number(manager.telegramId));
    let view: FinanceRequestView;
    let payments: StoredPayment[] | undefined;
    try {
      // the kind and the current sum decide which payments are valid
      if (dto.payments != null) {
        const current = (await this.finance.get(id)).request;
        payments = toEditPayments(current.kind, current.sum, dto);
      }
      view = await this.finance.edit(id, body);
    } catch (error) {
      throw financeError(error);
    }
    // finance accepted the edit, so a failed save must not turn it into an error
    if (payments) {
      try {
        card = await this.cards.setPayments(id, payments);
      } catch (error) {
        this.logger.error(`Request ${id} was edited but its payments were not saved`, error);
      }
    }
    // the edit is confirmed by now, so a failed redraw must not turn it into an error
    try {
      await this.sync.renderManager(card, view);
      await this.sync.renderGroup(card, view);
    } catch (error) {
      this.logger.error(`Request ${id} was edited but its cards were not redrawn`, error);
    }
    return this.response(manager, card, view);
  }

  @Post('requests/:id/complete')
  @HttpCode(HttpStatus.OK)
  complete(
    @MiniappManager() manager: Manager,
    @Param('id') id: string,
    @Body() dto: CompleteMiniappRequestDto,
  ): Promise<CompletionResult> {
    return this.completion.complete(manager, id, dto);
  }

  @Post('requests/:id/paid')
  @HttpCode(HttpStatus.OK)
  paid(
    @MiniappManager() manager: Manager,
    @Param('id') id: string,
    @Body() dto: PaidMiniappRequestDto,
  ): Promise<{ paidAt: string }> {
    return this.completion.markPaid(manager, id, dto);
  }

  /** Files for the request's first order; the cabinet's type and size rules, errors in its shape. */
  @Post('requests/:id/files')
  @UseFilters(DomainErrorFilter)
  @UseInterceptors(FilesInterceptor('files', MAX_FILES_PER_UPLOAD, attachmentUploadOptions))
  addFiles(
    @MiniappManager() manager: Manager,
    @Param('id') id: string,
    @UploadedFiles() files: Express.Multer.File[] = [],
  ): Promise<{ attached: number }> {
    return this.completion.addFiles(manager, id, files);
  }

  /** Another manager's request looks exactly like a missing one. */
  private async ownCard(manager: Manager, id: string): Promise<FinanceRequestCard> {
    const card = await this.cards.byRequestId(id);
    if (card?.managerId !== manager.id) throw notFound();
    return card;
  }

  private response(
    manager: Manager,
    card: FinanceRequestCard,
    request: FinanceRequestView,
  ): RequestResponse {
    return {
      request,
      managerName: manager.name,
      completed: card.completedAt != null,
      // a card completed before closing was tracked has no closedAt: only our_fop and foreign_fop stay open
      closed:
        card.closedAt != null || (card.completedAt != null && !paysAfterConfirm(request.kind)),
      payments: storedPayments(card.payments).map((payment) => {
        const paidAt = new Date(payment.paidAt);
        const { hour, minute } = kyivParts(paidAt);
        return {
          payerName: payment.payerName,
          account: payment.account,
          amount: payment.amount,
          date: kyivDate(paidAt),
          time: `${hour}:${minute}`,
        };
      }),
    };
  }
}
