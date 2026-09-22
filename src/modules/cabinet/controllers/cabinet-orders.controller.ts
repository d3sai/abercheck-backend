import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
  Res,
  StreamableFile,
  UploadedFiles,
  UseFilters,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FilesInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';
import {
  attachmentUploadOptions,
  MAX_FILES_PER_UPLOAD,
} from '../../attachments/attachments.constants';
import { AttachmentsService } from '../../attachments/attachments.service';
import { CurrentManager, Roles } from '../../auth/auth.decorators';
import { AuthErrors } from '../../auth/auth.errors';
import { SessionGuard } from '../../auth/session.guard';
import { type Manager, ManagerRole, ManagerStatus } from '../../../generated/prisma/client';
import { ManagersService } from '../../managers/managers.service';
import { UpdateOrderDto } from '../../orders/dto/update-order.dto';
import { OrderNotFoundError } from '../../orders/orders.errors';
import { type OrderLedger, OrdersService } from '../../orders/orders.service';
import { RefundsService } from '../../refunds/refunds.service';
import { RequisitesService } from '../../requisites/requisites.service';
import { canAccessOrder, initiatorOf, isAdmin, ownOrdersOf } from '../cabinet-access';
import { CabinetErrors } from '../cabinet.errors';
import {
  type OrderDetailView,
  type OrderSummaryView,
  type Page,
  toOrderDetail,
  toOrderSummary,
} from '../cabinet.views';
import { DomainErrorFilter } from './domain-error.filter';
import { CabinetCreateOrderDto, RefundDto } from '../dto/cabinet-body.dto';
import { OrdersQueryDto, paging } from '../dto/cabinet-query.dto';

@Controller('cabinet/orders')
@UseGuards(SessionGuard)
@UseFilters(DomainErrorFilter)
export class CabinetOrdersController {
  constructor(
    private readonly orders: OrdersService,
    private readonly managers: ManagersService,
    private readonly refunds: RefundsService,
    private readonly attachments: AttachmentsService,
    private readonly requisites: RequisitesService,
  ) {}

  @Get()
  async list(
    @CurrentManager() me: Manager,
    @Query() query: OrdersQueryDto,
  ): Promise<Page<OrderSummaryView>> {
    const { items, total } = await this.orders.search({
      managerId: ownOrdersOf(me) ?? query.managerId,
      statuses: query.status,
      text: query.search,
      sort: query.sort,
      direction: query.direction,
      ...paging(query),
    });
    return {
      items: items.map(toOrderSummary),
      total,
      page: query.page,
      pageSize: query.pageSize,
    };
  }

  @Get(':orderNumber')
  async detail(
    @CurrentManager() me: Manager,
    @Param('orderNumber') orderNumber: string,
  ): Promise<OrderDetailView> {
    return this.detailFor(me, orderNumber);
  }

  @Post()
  async create(
    @CurrentManager() me: Manager,
    @Body() { managerId, addPart, ...dto }: CabinetCreateOrderDto,
  ): Promise<OrderDetailView> {
    const order = await this.orders.create(await this.ownerFor(me, managerId), dto, { addPart });
    return this.detailFor(me, order.orderNumber);
  }

  @Patch(':orderNumber')
  async update(
    @CurrentManager() me: Manager,
    @Param('orderNumber') orderNumber: string,
    @Body() dto: UpdateOrderDto,
  ): Promise<OrderDetailView> {
    if (dto.amountDue !== undefined && !isAdmin(me)) {
      throw AuthErrors.forbidden();
    }
    const { order } = await this.ledger(me, orderNumber);
    await this.orders.update(order.orderNumber, dto, initiatorOf(me));
    return this.detailFor(me, order.orderNumber);
  }

  @Post(':orderNumber/refunds')
  @Roles(ManagerRole.ADMIN)
  async refund(
    @CurrentManager() me: Manager,
    @Param('orderNumber') orderNumber: string,
    @Body() dto: RefundDto,
  ): Promise<OrderDetailView> {
    const { order } = await this.ledger(me, orderNumber);
    await this.refunds.refund(order.id, dto.amount ?? null, initiatorOf(me));
    return this.detailFor(me, order.orderNumber);
  }

  @Post(':orderNumber/cancel')
  @Roles(ManagerRole.ADMIN)
  @HttpCode(HttpStatus.OK)
  async cancel(
    @CurrentManager() me: Manager,
    @Param('orderNumber') orderNumber: string,
  ): Promise<OrderDetailView> {
    const { order } = await this.ledger(me, orderNumber);
    await this.refunds.cancelUnpaid(order.id, initiatorOf(me));
    return this.detailFor(me, order.orderNumber);
  }

  @Post(':orderNumber/attachments')
  @UseInterceptors(FilesInterceptor('files', MAX_FILES_PER_UPLOAD, attachmentUploadOptions))
  async uploadAttachments(
    @CurrentManager() me: Manager,
    @Param('orderNumber') orderNumber: string,
    @UploadedFiles() files: Express.Multer.File[],
    @Body('atCreation') atCreation?: string,
  ): Promise<OrderDetailView> {
    if (!files?.length) {
      throw CabinetErrors.noFilesUploaded();
    }
    const { order } = await this.ledger(me, orderNumber);
    await this.attachments.save(order, files, initiatorOf(me), atCreation === 'true');
    return this.detailFor(me, order.orderNumber);
  }

  @Delete(':orderNumber/attachments/:id')
  @HttpCode(HttpStatus.OK)
  async removeAttachment(
    @CurrentManager() me: Manager,
    @Param('orderNumber') orderNumber: string,
    @Param('id', ParseIntPipe) id: number,
  ): Promise<OrderDetailView> {
    const { order } = await this.ledger(me, orderNumber);
    await this.attachments.remove(order.id, id);
    return this.detailFor(me, order.orderNumber);
  }

  @Get(':orderNumber/attachments/:id/download')
  async downloadAttachment(
    @CurrentManager() me: Manager,
    @Param('orderNumber') orderNumber: string,
    @Param('id', ParseIntPipe) id: number,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    const { order } = await this.ledger(me, orderNumber);
    const attachment = await this.attachments.find(order.id, id);
    const content = await this.attachments.readFile(attachment);
    res.set({
      'Content-Type': attachment.mimeType,
      'Content-Disposition': contentDisposition(attachment.filename),
    });
    return new StreamableFile(content);
  }

  private async ledger(me: Manager, orderNumber: string): Promise<OrderLedger> {
    const ledger = await this.orders.findLedger(orderNumber);
    if (!ledger || !canAccessOrder(me, ledger.order)) {
      throw new OrderNotFoundError(orderNumber);
    }
    return ledger;
  }

  private async detailFor(me: Manager, orderNumber: string): Promise<OrderDetailView> {
    const ledger = await this.ledger(me, orderNumber);
    const [attachments, requisites] = await Promise.all([
      this.attachments.list(ledger.order.id),
      this.requisites.list(ledger.order.id),
    ]);
    return toOrderDetail(ledger, attachments, requisites);
  }

  private async ownerFor(me: Manager, managerId: number | undefined): Promise<number> {
    if (managerId === undefined || managerId === me.id) {
      return me.id;
    }
    if (!isAdmin(me)) {
      throw AuthErrors.forbidden();
    }
    const owner = await this.managers.findById(managerId);
    if (owner?.status !== ManagerStatus.ACTIVE) {
      throw CabinetErrors.managerNotActive();
    }
    return owner.id;
  }
}

function contentDisposition(filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7E]/g, '_').replace(/["\\]/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}
