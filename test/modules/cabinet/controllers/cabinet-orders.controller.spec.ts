import { CabinetOrdersController } from '../../../../src/modules/cabinet/controllers/cabinet-orders.controller';
import type { CabinetCreateOrderDto } from '../../../../src/modules/cabinet/dto/cabinet-body.dto';
import type { OrdersQueryDto } from '../../../../src/modules/cabinet/dto/cabinet-query.dto';
import { ApiError } from '../../../../src/common/api-error';
import {
  type Manager,
  ManagerRole,
  ManagerStatus,
  OrderStatus,
  Prisma,
} from '../../../../src/generated/prisma/client';
import type { AttachmentsService } from '../../../../src/modules/attachments/attachments.service';
import type { ManagersService } from '../../../../src/modules/managers/managers.service';
import { OrderNotFoundError } from '../../../../src/modules/orders/orders.errors';
import type { OrdersService } from '../../../../src/modules/orders/orders.service';
import type { RefundsService } from '../../../../src/modules/refunds/refunds.service';
import type { RequisitesService } from '../../../../src/modules/requisites/requisites.service';

const d = (value: string) => new Prisma.Decimal(value);

async function failure(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ApiError) {
      return (error.getResponse() as { code: string }).code;
    }
    throw error;
  }
  throw new Error('Expected the call to fail');
}

const ledgerOf = (managerId: number) => {
  const order = {
    id: 1,
    orderNumber: '0000-066717',
    baseNumber: '0000-066717',
    clientName: 'Чернявський Владислав',
    amountDue: d('6158.41'),
    exchangeRate: null,
    comment: null,
    status: OrderStatus.AWAITING_PAYMENT,
    managerId,
    manager: { id: managerId, name: 'Олена' },
    createdAt: new Date('2026-09-03T12:00:00Z'),
    updatedAt: new Date('2026-09-03T12:00:00Z'),
  };
  return {
    order,
    amountPaid: d('0'),
    payments: [],
    refunds: [],
    group: {
      baseNumber: '0000-066717',
      amountDue: order.amountDue,
      amountPaid: d('0'),
      status: OrderStatus.AWAITING_PAYMENT,
      parts: [order],
    },
  };
};

describe('CabinetOrdersController', () => {
  const orders = { search: jest.fn(), findLedger: jest.fn(), create: jest.fn(), update: jest.fn() };
  const managers = { findById: jest.fn() };
  const refunds = { refund: jest.fn(), cancelUnpaid: jest.fn() };
  const attachments = { list: jest.fn() };
  const requisites = { list: jest.fn() };
  const controller = new CabinetOrdersController(
    orders as unknown as OrdersService,
    managers as unknown as ManagersService,
    refunds as unknown as RefundsService,
    attachments as unknown as AttachmentsService,
    requisites as unknown as RequisitesService,
  );
  const manager = {
    id: 7,
    telegramId: 5000000000n,
    name: 'Олена',
    role: ManagerRole.MANAGER,
    status: ManagerStatus.ACTIVE,
  } as Manager;
  const admin = { ...manager, id: 1, telegramId: 111n, name: 'Уляна', role: ManagerRole.ADMIN };
  const dto: CabinetCreateOrderDto = {
    orderNumber: '0000-066717',
    clientName: 'Чернявський Владислав',
    amountDue: '6158.41',
  };

  beforeEach(() => {
    attachments.list.mockResolvedValue([]);
    requisites.list.mockResolvedValue([]);
  });
  afterEach(() => jest.resetAllMocks());

  describe('list', () => {
    const query = {
      page: 2,
      pageSize: 10,
      sort: 'createdAt',
      direction: 'desc',
      managerId: 99,
    } as OrdersQueryDto;

    beforeEach(() => orders.search.mockResolvedValue({ items: [], total: 0 }));

    it('should keep a manager to their own orders whatever the filter says', async () => {
      await controller.list(manager, query);

      expect(orders.search).toHaveBeenCalledWith(
        expect.objectContaining({ managerId: 7, skip: 10, take: 10 }),
      );
    });

    it('should let an admin filter by any manager', async () => {
      await controller.list(admin, query);

      expect(orders.search).toHaveBeenCalledWith(expect.objectContaining({ managerId: 99 }));
    });
  });

  describe('detail', () => {
    it("should report another manager's order as missing", async () => {
      orders.findLedger.mockResolvedValue(ledgerOf(8));

      await expect(controller.detail(manager, '0000-066717')).rejects.toBeInstanceOf(
        OrderNotFoundError,
      );
    });

    it('should show admins any order with its balance', async () => {
      orders.findLedger.mockResolvedValue(ledgerOf(8));

      await expect(controller.detail(admin, '0000-066717')).resolves.toMatchObject({
        orderNumber: '0000-066717',
        amountPaid: '0.00',
        amountRemaining: '6158.41',
        manager: { id: 8, name: 'Олена' },
        group: {
          baseNumber: '0000-066717',
          amountRemaining: '6158.41',
          parts: [{ id: 1, orderNumber: '0000-066717', amountDue: '6158.41' }],
        },
      });
    });
  });

  describe('create', () => {
    it('should create the order for the current manager by default', async () => {
      orders.create.mockResolvedValue({ orderNumber: '0000-066717' });
      orders.findLedger.mockResolvedValue(ledgerOf(7));

      await controller.create(manager, dto);

      expect(orders.create).toHaveBeenCalledWith(7, dto, { addPart: undefined });
    });

    it('should let the caller ask for one more part of a number that is already taken', async () => {
      orders.create.mockResolvedValue({ orderNumber: '0000-066717(1)' });
      orders.findLedger.mockResolvedValue(ledgerOf(7));

      await controller.create(manager, { ...dto, addPart: true });

      expect(orders.create).toHaveBeenCalledWith(7, dto, { addPart: true });
      expect(orders.findLedger).toHaveBeenCalledWith('0000-066717(1)');
    });

    it('should not let a manager create orders for someone else', async () => {
      await expect(failure(controller.create(manager, { ...dto, managerId: 8 }))).resolves.toBe(
        'FORBIDDEN',
      );
      expect(orders.create).not.toHaveBeenCalled();
    });

    it('should let an admin assign an order only to an active manager', async () => {
      managers.findById.mockResolvedValue({ id: 8, status: ManagerStatus.PENDING });

      await expect(failure(controller.create(admin, { ...dto, managerId: 8 }))).resolves.toBe(
        'MANAGER_NOT_ACTIVE',
      );
    });
  });

  describe('update', () => {
    it('should not let a manager change amountDue', async () => {
      await expect(
        failure(controller.update(manager, '0000-066717', { amountDue: '100' })),
      ).resolves.toBe('FORBIDDEN');
      expect(orders.update).not.toHaveBeenCalled();
    });

    it('should let a manager edit other fields without touching amountDue', async () => {
      orders.findLedger.mockResolvedValue(ledgerOf(7));

      await controller.update(manager, '0000-066717', { comment: 'дзвонив клієнт' });

      expect(orders.update).toHaveBeenCalledWith(
        '0000-066717',
        { comment: 'дзвонив клієнт' },
        { telegramId: 5000000000n, name: 'Олена' },
      );
    });

    it("should let an admin change amountDue in the admin's name", async () => {
      orders.findLedger.mockResolvedValue(ledgerOf(8));

      await controller.update(admin, '0000-066717', { amountDue: '100' });

      expect(orders.update).toHaveBeenCalledWith(
        '0000-066717',
        { amountDue: '100' },
        { telegramId: 111n, name: 'Уляна' },
      );
    });
  });

  it('should record a full refund in the name of the admin', async () => {
    orders.findLedger.mockResolvedValue(ledgerOf(8));

    await controller.refund(admin, '0000-066717', {});

    expect(refunds.refund).toHaveBeenCalledWith(1, null, { telegramId: 111n, name: 'Уляна' });
  });
});
