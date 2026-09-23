import { ConfigModule } from '@nestjs/config';
import { type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { validateEnv } from '../../src/common/config/env.validation';
import { PrismaModule } from '../../src/common/prisma/prisma.module';
import { PrismaService } from '../../src/common/prisma/prisma.service';
import { ManagerRole, ManagerStatus } from '../../src/generated/prisma/client';

// A distinctive marker on everything these tests create, so it's unmistakable in the database
// (and easy to sweep up by hand) if a run is ever interrupted before cleanup.
export const TEST_MARKER = 'integration-test';

export interface IntegrationContext {
  app: INestApplication;
  prisma: PrismaService;
  close: () => Promise<void>;
}

// A real PrismaService, wired exactly like the app wires it (ConfigModule + PrismaModule), talking
// to whatever DATABASE_URL is configured in .env. There is no mocking here on purpose: these tests
// exist to catch the things a mocked PrismaService cannot — real transactions, real row locks, real
// groupBy/having queries against the actual schema.
export async function createIntegrationContext(): Promise<IntegrationContext> {
  const moduleRef = await Test.createTestingModule({
    imports: [ConfigModule.forRoot({ isGlobal: true, validate: validateEnv }), PrismaModule],
  }).compile();

  const app = moduleRef.createNestApplication();
  await app.init();
  const prisma = app.get(PrismaService);

  return { app, prisma, close: () => app.close() };
}

let managerSeq = 0;

// A dedicated manager per test, identified by a marker in the name and a telegram id far outside
// any real Telegram id range, so it can never collide with real data.
export async function createTestManager(
  prisma: PrismaService,
  overrides: Partial<{ role: ManagerRole; status: ManagerStatus }> = {},
) {
  managerSeq += 1;
  return prisma.manager.create({
    data: {
      telegramId: BigInt(`9${Date.now()}${managerSeq}`),
      name: `[${TEST_MARKER}] manager ${managerSeq}`,
      status: overrides.status ?? ManagerStatus.ACTIVE,
      role: overrides.role ?? ManagerRole.MANAGER,
    },
  });
}

let orderSeq = 0;

// A unique, obviously-synthetic order number/base number pair, so tests never collide with each
// other or with real 1C numbers (which are never in the "9999-9" range).
export function testOrderNumber(): string {
  orderSeq += 1;
  return `9999-9${Date.now().toString().slice(-5)}${orderSeq}`;
}

// Deletes everything that can reference an order, then the order itself — the schema uses
// onDelete: Restrict everywhere, so children must go first.
export async function deleteOrders(prisma: PrismaService, orderIds: number[]): Promise<void> {
  if (orderIds.length === 0) {
    return;
  }
  const where = { orderId: { in: orderIds } };
  await prisma.refund.deleteMany({ where });
  await prisma.payment.deleteMany({ where });
  await prisma.orderRequisite.deleteMany({ where });
  await prisma.orderAttachment.deleteMany({ where });
  await prisma.orderAmountChange.deleteMany({ where });
  await prisma.order.deleteMany({ where: { id: { in: orderIds } } });
}

export async function deleteManagers(prisma: PrismaService, managerIds: number[]): Promise<void> {
  if (managerIds.length === 0) {
    return;
  }
  await prisma.manager.deleteMany({ where: { id: { in: managerIds } } });
}
