import { EventEmitter2 } from '@nestjs/event-emitter';
import type { Manager, Order } from '../../src/generated/prisma/client';
import { OrdersService } from '../../src/modules/orders/orders.service';
import {
  createIntegrationContext,
  createTestManager,
  deleteManagers,
  deleteOrders,
  type IntegrationContext,
  testOrderNumber,
} from './setup';

// OrdersService.findUnpaid drives its pagination off a real groupBy/having/_min query — behavior
// that a mocked PrismaService can only assert was "called with", never that it actually returns the
// right page against Postgres. This exercises it against the real database.
describe('OrdersService.findUnpaid (integration)', () => {
  let ctx: IntegrationContext;
  let orders: OrdersService;
  let manager: Manager;
  let created: Order[];

  beforeAll(async () => {
    ctx = await createIntegrationContext();
    orders = new OrdersService(ctx.prisma, new EventEmitter2());
    manager = await createTestManager(ctx.prisma);

    // Three unpaid orders, each its own group, created in a known order.
    created = [];
    for (let i = 0; i < 3; i += 1) {
      const orderNumber = testOrderNumber();
      created.push(
        await ctx.prisma.order.create({
          data: {
            orderNumber,
            baseNumber: orderNumber,
            clientName: `Test Client ${i}`,
            amountDue: '100.00',
            managerId: manager.id,
          },
        }),
      );
    }
  });

  afterAll(async () => {
    await deleteOrders(
      ctx.prisma,
      created.map((order) => order.id),
    );
    await deleteManagers(ctx.prisma, [manager.id]);
    await ctx.close();
  });

  it('paginates unpaid groups by id cursor until every group is returned exactly once', async () => {
    const seen: number[] = [];
    let cursor: number | undefined;
    // Small page size on purpose, so pagination genuinely runs across several pages.
    for (let guard = 0; guard < 50; guard += 1) {
      const page = await orders.findUnpaid(1, cursor);
      seen.push(...page.items.map((item) => item.order.id));
      if (page.nextCursor === null) {
        break;
      }
      cursor = page.nextCursor;
    }

    // No duplicates across pages, and every one of our synthetic unpaid orders shows up.
    expect(new Set(seen).size).toBe(seen.length);
    const ourIds = created.map((order) => order.id);
    expect(ourIds.every((id) => seen.includes(id))).toBe(true);
  });

  it('reports zero amountPaid for orders with no payments', async () => {
    const found = await orders.findWithBalance(created[0]!.orderNumber);

    expect(found).not.toBeNull();
    expect(found!.amountPaid.toString()).toBe('0');
    expect(found!.order.orderNumber).toBe(created[0]!.orderNumber);
  });
});
