import { EventEmitter2 } from '@nestjs/event-emitter';
import type { Manager, Order, Payment } from '../../src/generated/prisma/client';
import { MatchType, OrderStatus } from '../../src/generated/prisma/client';
import { OrderCancelledError, OrderNotFoundError } from '../../src/modules/orders/orders.errors';
import { PaymentAlreadyAttachedError } from '../../src/modules/payments/payments.errors';
import { PaymentsService } from '../../src/modules/payments/payments.service';
import {
  createIntegrationContext,
  createTestManager,
  deleteManagers,
  deleteOrders,
  type IntegrationContext,
  testOrderNumber,
} from './setup';

// PaymentsService.attach takes a real `SELECT ... FOR UPDATE` row lock (see order-ledger.ts) before
// updating the payment and syncing the order's status inside one $transaction. A mocked
// PrismaService can't prove that lock, that transaction, or the real status-recalculation query
// actually work against Postgres — only a real database can.
describe('PaymentsService.attach (integration)', () => {
  let ctx: IntegrationContext;
  let payments: PaymentsService;
  let manager: Manager;
  const orderIds: number[] = [];
  const paymentIds: number[] = [];

  beforeAll(async () => {
    ctx = await createIntegrationContext();
    payments = new PaymentsService(ctx.prisma, new EventEmitter2());
    manager = await createTestManager(ctx.prisma);
  });

  afterAll(async () => {
    // Payments that a test deliberately left unattached (the error-path tests) aren't reachable
    // through deleteOrders' orderId-based cleanup, so they're removed by id directly first.
    await ctx.prisma.payment.deleteMany({ where: { id: { in: paymentIds } } });
    await deleteOrders(ctx.prisma, orderIds);
    await deleteManagers(ctx.prisma, [manager.id]);
    await ctx.close();
  });

  async function makeOrder(amountDue: string): Promise<Order> {
    const orderNumber = testOrderNumber();
    const order = await ctx.prisma.order.create({
      data: {
        orderNumber,
        baseNumber: orderNumber,
        clientName: 'Test Client',
        amountDue,
        managerId: manager.id,
      },
    });
    orderIds.push(order.id);
    return order;
  }

  async function makeUnmatchedPayment(amount: string): Promise<Payment> {
    const payment = await ctx.prisma.payment.create({
      data: {
        externalTransactionId: `${Date.now()}-${Math.random()}`,
        amount,
        paidAt: new Date(),
        matchType: MatchType.MANUAL,
      },
    });
    paymentIds.push(payment.id);
    return payment;
  }

  it('locks the payment row, attaches it, and syncs the order status for real', async () => {
    const order = await makeOrder('500.00');
    const payment = await makeUnmatchedPayment('500.00');

    const result = await payments.attach(payment.id, order.orderNumber);

    expect(result.order.status).toBe(OrderStatus.PAID);
    expect(result.amountPaid.toString()).toBe('500');

    const reloadedOrder = await ctx.prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    const reloadedPayment = await ctx.prisma.payment.findUniqueOrThrow({
      where: { id: payment.id },
    });
    expect(reloadedOrder.status).toBe(OrderStatus.PAID);
    expect(reloadedPayment.orderId).toBe(order.id);
  });

  it('refuses to attach a payment that is already attached, re-checked against the real row', async () => {
    const order = await makeOrder('100.00');
    const payment = await makeUnmatchedPayment('100.00');
    await payments.attach(payment.id, order.orderNumber);

    const other = await makeOrder('100.00');
    await expect(payments.attach(payment.id, other.orderNumber)).rejects.toThrow(
      PaymentAlreadyAttachedError,
    );
  });

  it('refuses to attach to an order that does not exist', async () => {
    const payment = await makeUnmatchedPayment('50.00');

    await expect(payments.attach(payment.id, '9999-900000')).rejects.toThrow(OrderNotFoundError);
  });

  it('refuses to attach to a cancelled order', async () => {
    const order = await makeOrder('100.00');
    await ctx.prisma.order.update({
      where: { id: order.id },
      data: { status: OrderStatus.CANCELLED },
    });
    const payment = await makeUnmatchedPayment('100.00');

    await expect(payments.attach(payment.id, order.orderNumber)).rejects.toThrow(
      OrderCancelledError,
    );
  });
});
