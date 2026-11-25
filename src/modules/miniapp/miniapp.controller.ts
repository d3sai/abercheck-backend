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
import { storedPayments } from '../finance-sync/stored-payments';
import {
  type DirectOrdersResult,
  type DirectOrderView,
  DirectOrdersService,
} from './direct-orders.service';
import { MiniappManager, MiniappAuthGuard } from './miniapp-auth.guard';
import {
  CompleteMiniappRequestDto,
  CreateMiniappOrderDto,
  AddPaymentsMiniappDto,
  CreateMiniappRequestDto,
  EditMiniappRequestDto,
  PaidMiniappRequestDto,
  toCreateInput,
  toEditBody,
  toOrderPlan,
} from './miniapp.dto';
import { financeError, notFound } from './miniapp.errors';
import { PendingOrdersService } from './pending-orders.service';
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
    date: string | null;
    time: string | null;
  }[];
  /** A completed our_fop or foreign_fop: what its payments add up to against the orders' sum. */
  progress: { paid: string; due: string } | null;
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
    private readonly pendingOrders: PendingOrdersService,
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

  /** Kit, cash and foreign payments: a card in the manager's chat; the orders come with «Прийняти». */
  @Post('orders')
  async createOrders(
    @MiniappManager() manager: Manager,
    @Body() dto: CreateMiniappOrderDto,
  ): Promise<DirectOrdersResult> {
    return this.pendingOrders.submit(manager, toOrderPlan(dto));
  }

  @Get('orders/:number')
  order(
    @MiniappManager() manager: Manager,
    @Param('number') number: string,
  ): Promise<DirectOrderView> {
    return this.directOrders.view(manager, number);
  }

  @Post('orders/:number/paid')
  @HttpCode(HttpStatus.OK)
  orderPaid(
    @MiniappManager() manager: Manager,
    @Param('number') number: string,
    @Body() dto: PaidMiniappRequestDto,
  ): Promise<{ paidAt: string }> {
    return this.directOrders.markPaid(manager, number, dto);
  }

  @Get('requests/:id')
  async get(@MiniappManager() manager: Manager, @Param('id') id: string): Promise<RequestResponse> {
    const card = await this.ownCard(manager, id);
    try {
      return await this.response(manager, card, (await this.finance.get(id)).request);
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
    const card = await this.ownCard(manager, id);
    const body = toEditBody(dto, Number(manager.telegramId));
    let view: FinanceRequestView;
    try {
      view = await this.finance.edit(id, body);
    } catch (error) {
      throw financeError(error);
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

  @Post('requests/:id/payments')
  @HttpCode(HttpStatus.OK)
  payments(
    @MiniappManager() manager: Manager,
    @Param('id') id: string,
    @Body() dto: AddPaymentsMiniappDto,
  ): Promise<{ paid: string; due: string }> {
    return this.completion.addPayments(manager, id, dto);
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

  private async response(
    manager: Manager,
    card: FinanceRequestCard,
    request: FinanceRequestView,
  ): Promise<RequestResponse> {
    const progress =
      card.completedAt != null && paysAfterConfirm(request.kind)
        ? await this.completion.progress(card.orderIds)
        : null;
    return {
      request,
      managerName: manager.name,
      completed: card.completedAt != null,
      // a card completed before closing was tracked has no closedAt: only our_fop and foreign_fop stay open
      closed:
        card.closedAt != null || (card.completedAt != null && !paysAfterConfirm(request.kind)),
      payments: storedPayments(card.payments).map((payment) => {
        const base = {
          payerName: payment.payerName,
          account: payment.account,
          amount: payment.amount,
        };
        if (payment.paidAt === null) return { ...base, date: null, time: null };
        const paidAt = new Date(payment.paidAt);
        const { hour, minute } = kyivParts(paidAt);
        return { ...base, date: kyivDate(paidAt), time: `${hour}:${minute}` };
      }),
      progress: progress && { paid: progress.paid.toFixed(2), due: progress.due.toFixed(2) },
    };
  }
}
