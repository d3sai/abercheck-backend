import { Test } from '@nestjs/testing';
import { Prisma } from '../../../../src/generated/prisma/client';
import type { OrderCreated } from '../../../../src/modules/orders/order.events';
import { PrismaService } from '../../../../src/common/prisma/prisma.service';
import { OrderNotifier } from '../../../../src/modules/telegram/notifications/order-notifier';
import { TelegramSender } from '../../../../src/modules/telegram/core/telegram-sender';

describe('OrderNotifier', () => {
  const prisma = { manager: { findUniqueOrThrow: jest.fn() } };
  const sender = { sendToAdmins: jest.fn() };
  let notifier: OrderNotifier;

  const event: OrderCreated = {
    order: {
      id: 1,
      orderNumber: '0000-067968',
      baseNumber: '0000-067968',
      clientName: 'ФОП Берчатова Лариса',
      amountDue: new Prisma.Decimal('170.10'),
      exchangeRate: null,
      comment: null,
      requisites: null,
      orderType: 'REGULAR',
      status: 'AWAITING_PAYMENT',
      managerId: 7,
      createdAt: new Date('2026-09-12T09:57:00Z'),
      updatedAt: new Date('2026-09-12T09:57:00Z'),
    },
  };

  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [
        OrderNotifier,
        { provide: PrismaService, useValue: prisma },
        { provide: TelegramSender, useValue: sender },
      ],
    }).compile();

    notifier = moduleRef.get(OrderNotifier);
    prisma.manager.findUniqueOrThrow.mockResolvedValue({ id: 7, name: 'Христина' });
  });

  afterEach(() => jest.resetAllMocks());

  it('should tell the admin chat about the new order', async () => {
    await notifier.onCreated(event);

    expect(prisma.manager.findUniqueOrThrow).toHaveBeenCalledWith({ where: { id: 7 } });
    expect(sender.sendToAdmins).toHaveBeenCalledWith(expect.stringContaining('Нове замовлення'));
    expect(sender.sendToAdmins).toHaveBeenCalledWith(expect.stringContaining('Христина'));
  });

  it('should swallow errors so order creation is not affected', async () => {
    prisma.manager.findUniqueOrThrow.mockRejectedValue(new Error('db down'));

    await expect(notifier.onCreated(event)).resolves.toBeUndefined();
    expect(sender.sendToAdmins).not.toHaveBeenCalled();
  });
});
