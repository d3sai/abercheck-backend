import { Test } from '@nestjs/testing';
import { MatchType, OrderStatus, OrderType, Prisma } from '../../../../src/generated/prisma/client';
import type { PaymentRecorded } from '../../../../src/modules/payments/payment-ingestion.types';
import { PrismaService } from '../../../../src/common/prisma/prisma.service';
import { TelegramSender } from '../../../../src/modules/telegram/core/telegram-sender';
import { PaymentNotifier } from '../../../../src/modules/telegram/notifications/payment-notifier';

describe('PaymentNotifier', () => {
  const prisma = {
    manager: { findUniqueOrThrow: jest.fn() },
    payment: { findMany: jest.fn() },
  };
  const sender = { send: jest.fn(), sendToAdmins: jest.fn() };
  let notifier: PaymentNotifier;

  const payment = {
    id: 5,
    externalTransactionId: 'tx-5',
    amount: new Prisma.Decimal('3614.32'),
    payerName: 'Платник',
    receivingAccount: 'ФОП Гук В.С',
    purposeText: '',
    paidAt: new Date('2026-09-03T12:00:00Z'),
    reportedOrderNumber: '0000-066717',
    orderId: 1,
    matchType: MatchType.MATCHED_BY_PROVIDER,
    createdAt: new Date(),
  };
  const event = (status: OrderStatus, amountPaid = '3614.32'): PaymentRecorded => ({
    kind: 'recorded',
    payment,
    previousStatus: OrderStatus.AWAITING_PAYMENT,
    amountPaid: new Prisma.Decimal(amountPaid),
    order: {
      id: 1,
      orderNumber: '0000-066717',
      baseNumber: '0000-066717',
      clientName: 'Клієнт',
      amountDue: new Prisma.Decimal('3000'),
      exchangeRate: null,
      comment: null,
      requisites: null,
      paidAt: null,
      ourFop: null,
      period: null,
      sheetUrl: null,
      orderType: OrderType.REGULAR,
      status,
      managerId: 7,
      createdAt: new Date(),
      updatedAt: new Date(),
    },
  });

  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [
        PaymentNotifier,
        { provide: PrismaService, useValue: prisma },
        { provide: TelegramSender, useValue: sender },
      ],
    }).compile();

    notifier = moduleRef.get(PaymentNotifier);
    prisma.manager.findUniqueOrThrow.mockResolvedValue({
      id: 7,
      telegramId: 5000000000n,
      name: 'Христина',
    });
    prisma.payment.findMany.mockResolvedValue([payment]);
  });

  afterEach(() => jest.resetAllMocks());

  it('should notify only the manager about a regular payment', async () => {
    await notifier.onRecorded(event(OrderStatus.PARTIALLY_PAID, '1000'));

    expect(sender.send).toHaveBeenCalledWith(
      5000000000n,
      expect.stringContaining('часткову оплату'),
    );
    expect(sender.sendToAdmins).not.toHaveBeenCalled();
  });

  it('should describe the order as of this payment, not later ones', async () => {
    await notifier.onRecorded(event(OrderStatus.PAID));

    expect(prisma.payment.findMany).toHaveBeenCalledWith({
      where: { order: { baseNumber: '0000-066717' }, id: { lte: 5 } },
      orderBy: [{ paidAt: 'asc' }, { id: 'asc' }],
    });
  });

  it('should also alert admins about an overpayment', async () => {
    await notifier.onRecorded(event(OrderStatus.OVERPAID));

    expect(sender.send).toHaveBeenCalledWith(5000000000n, expect.stringContaining('переплату'));
    expect(sender.sendToAdmins).toHaveBeenCalledWith(expect.stringContaining('Менеджер: Христина'));
  });

  it('should swallow errors so the payment flow is not affected', async () => {
    prisma.manager.findUniqueOrThrow.mockRejectedValue(new Error('db down'));

    await expect(notifier.onRecorded(event(OrderStatus.PAID))).resolves.toBeUndefined();
  });

  it('should send unknown payments to the admin chat with an attach button', async () => {
    await notifier.onUnmatched({ kind: 'unmatched', payment: { ...payment, orderId: null } });

    expect(sender.sendToAdmins).toHaveBeenCalledWith(expect.stringContaining('Невідомий платіж'), [
      [{ text: "🔗 Прив'язати до замовлення", callback_data: 'attach:5' }],
    ]);
  });

  it('should swallow errors when notifying about an unmatched payment', async () => {
    sender.sendToAdmins.mockRejectedValue(new Error('telegram down'));

    await expect(
      notifier.onUnmatched({ kind: 'unmatched', payment: { ...payment, orderId: null } }),
    ).resolves.toBeUndefined();
  });

  it('should tell the manager about a refund on their order', async () => {
    const { order } = event(OrderStatus.PAID);

    await notifier.onRefund({
      order,
      previousStatus: OrderStatus.OVERPAID,
      amountPaid: new Prisma.Decimal('3000'),
      refund: {
        id: 1,
        orderId: 1,
        amount: new Prisma.Decimal('50'),
        type: 'PARTIAL',
        initiatedByTelegramId: 111n,
        initiatedByName: 'Уляна',
        note: null,
        createdAt: new Date(),
      },
    });

    expect(prisma.manager.findUniqueOrThrow).toHaveBeenCalledWith({ where: { id: 7 } });
    expect(sender.send).toHaveBeenCalledWith(
      5000000000n,
      expect.stringMatching(/Повернено: 50 грн[\s\S]*Статус: 🟢 Оплачено[\s\S]*Уляна/),
    );
  });

  it('should tell the manager their unpaid order was cancelled', async () => {
    await notifier.onCancelled({
      order: event(OrderStatus.CANCELLED).order,
      previousStatus: OrderStatus.AWAITING_PAYMENT,
      initiator: { telegramId: 111n, name: 'Уляна' },
    });

    expect(sender.send).toHaveBeenCalledWith(
      5000000000n,
      expect.stringContaining('Замовлення скасовано'),
    );
  });
});
