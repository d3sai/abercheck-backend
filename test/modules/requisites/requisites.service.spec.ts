import { PrismaService } from '../../../src/common/prisma/prisma.service';
import { RequisitesService } from '../../../src/modules/requisites/requisites.service';

describe('RequisitesService', () => {
  const orderRequisite = { create: jest.fn(), findMany: jest.fn() };
  const prisma = { orderRequisite };
  const service = new RequisitesService(prisma as unknown as PrismaService);

  afterEach(() => jest.resetAllMocks());

  describe('addMany', () => {
    it('should create one row per item, in order, stamped with who added them', async () => {
      orderRequisite.create.mockImplementation(({ data }: { data: object }) => ({
        id: 1,
        ...data,
      }));
      const items = [
        {
          payerName: 'Носенко Роман',
          account: '5168 7451 7598 8366',
          amount: '4527.00',
          paidAt: new Date('2026-09-07T11:57:00Z'),
        },
        {
          payerName: 'Андріанов Олександр',
          account: '4441 1110 6964 5962',
          amount: '2140.00',
          paidAt: new Date('2026-09-07T11:59:00Z'),
        },
      ];

      const created = await service.addMany(5, items, { telegramId: 111n, name: 'Христина' });

      expect(created).toHaveLength(2);
      expect(orderRequisite.create).toHaveBeenNthCalledWith(1, {
        data: {
          orderId: 5,
          payerName: 'Носенко Роман',
          account: '5168 7451 7598 8366',
          amount: '4527.00',
          paidAt: items[0]!.paidAt,
          addedByTelegramId: 111n,
          addedByName: 'Христина',
        },
      });
      expect(orderRequisite.create).toHaveBeenNthCalledWith(2, {
        data: expect.objectContaining({ orderId: 5, payerName: 'Андріанов Олександр' }) as unknown,
      });
    });

    it('should create nothing for an empty list', async () => {
      const created = await service.addMany(5, [], { telegramId: 111n, name: 'Христина' });

      expect(created).toEqual([]);
      expect(orderRequisite.create).not.toHaveBeenCalled();
    });
  });

  describe('list', () => {
    it("should list an order's requisites in chronological order", async () => {
      orderRequisite.findMany.mockResolvedValue([{ id: 1 }]);

      const result = await service.list(5);

      expect(orderRequisite.findMany).toHaveBeenCalledWith({
        where: { orderId: 5 },
        orderBy: [{ paidAt: 'asc' }, { id: 'asc' }],
      });
      expect(result).toEqual([{ id: 1 }]);
    });
  });
});
