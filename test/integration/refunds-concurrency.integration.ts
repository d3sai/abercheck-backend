import { EventEmitter2 } from '@nestjs/event-emitter';
import type { Manager, Order } from '../../src/generated/prisma/client';
import { MatchType } from '../../src/generated/prisma/client';
import { NothingToRefundError } from '../../src/modules/refunds/refunds.errors';
import { RefundsService } from '../../src/modules/refunds/refunds.service';
import {
  createIntegrationContext,
  createTestManager,
  deleteManagers,
  deleteOrders,
  type IntegrationContext,
  testOrderNumber,
} from './setup';

// RefundsService.refund locks the order row (`SELECT ... FOR UPDATE`, see order-ledger.ts#lockOrderById)
// before recomputing the net-paid amount and writing a refund. That lock is the only thing standing
// between "two admins tap refund at the same moment" and a double refund. A unit test with a mocked
// PrismaService can't prove the lock actually serializes the two transactions — only a race against a
// real database can.
describe('RefundsService.refund concurrency (integration)', () => {
  let ctx: IntegrationContext;
  let refunds: RefundsService;
  let manager: Manager;
  let order: Order;

  beforeAll(async () => {
    ctx = await createIntegrationContext();
    refunds = new RefundsService(ctx.prisma, new EventEmitter2());
    manager = await createTestManager(ctx.prisma);

    const orderNumber = testOrderNumber();
    order = await ctx.prisma.order.create({
      data: {
        orderNumber,
        baseNumber: orderNumber,
        clientName: 'Test Client',
        amountDue: '1000.00',
        managerId: manager.id,
      },
    });
    await ctx.prisma.payment.create({
      data: {
        externalTransactionId: `${Date.now()}-${Math.random()}`,
        amount: '1000.00',
        paidAt: new Date(),
        matchType: MatchType.MANUAL,
        orderId: order.id,
      },
    });
  });

  afterAll(async () => {
    await deleteOrders(ctx.prisma, [order.id]);
    await deleteManagers(ctx.prisma, [manager.id]);
    await ctx.close();
  });

  it('lets exactly one of two simultaneous full refunds succeed, never both', async () => {
    const initiator = { telegramId: manager.telegramId, name: manager.name };

    const results = await Promise.allSettled([
      refunds.refund(order.id, '1000.00', initiator),
      refunds.refund(order.id, '1000.00', initiator),
    ]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]!.reason).toBeInstanceOf(NothingToRefundError);

    // The database itself agrees: exactly one refund row, for the full amount — not two, and not zero.
    const recorded = await ctx.prisma.refund.findMany({ where: { orderId: order.id } });
    expect(recorded).toHaveLength(1);
    expect(recorded[0]!.amount.toString()).toBe('1000');
  });
});
