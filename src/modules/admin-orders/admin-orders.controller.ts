import { Body, Controller, Delete, Get, Headers, Param, UseGuards } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';
import { AdminKeyGuard } from '../../common/guards/admin-key.guard';
import { AdminOrdersService } from './admin-orders.service';
import { DeleteOrderDto } from './dto/delete-order.dto';
import type { DeleteResultResponse, OrderPreviewResponse } from './dto/order-preview.response';

const ACTOR_MAX_LENGTH = 64;

@Controller('admin/orders')
@UseGuards(AdminKeyGuard, ThrottlerGuard)
export class AdminOrdersController {
  constructor(private readonly adminOrders: AdminOrdersService) {}

  @Get(':orderNumber')
  preview(@Param('orderNumber') orderNumber: string): Promise<OrderPreviewResponse> {
    return this.adminOrders.preview(orderNumber);
  }

  @Delete(':orderNumber')
  remove(
    @Param('orderNumber') orderNumber: string,
    @Body() dto: DeleteOrderDto,
    @Headers('x-actor') actor: string | undefined,
  ): Promise<DeleteResultResponse> {
    const name = actor?.trim().slice(0, ACTOR_MAX_LENGTH);
    return this.adminOrders.remove(
      orderNumber,
      dto,
      name === undefined || name === '' ? 'unknown' : name,
    );
  }
}
