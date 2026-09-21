import { Test } from '@nestjs/testing';
import { OrderStatus, Prisma } from '../../../../src/generated/prisma/client';
import { OrderCancelledError } from '../../../../src/modules/orders/orders.errors';
import { OrdersService } from '../../../../src/modules/orders/orders.service';
import { PaymentAlreadyAttachedError } from '../../../../src/modules/payments/payments.errors';
import { PaymentsService } from '../../../../src/modules/payments/payments.service';
import { RefundAmountError } from '../../../../src/modules/refunds/refunds.errors';
import { RefundsService } from '../../../../src/modules/refunds/refunds.service';
import type { BotReply } from '../../../../src/modules/telegram/core/bot-reply';
import { AdminFlowService } from '../../../../src/modules/telegram/admin/admin-flow.service';

const d = (value: string) => new Prisma.Decimal(value);
const callbacks = (reply: BotReply) =>
  reply.buttons?.flat().map((b) => ('callback_data' in b ? b.callback_data : undefined));

describe('AdminFlowService', () => {
  const admin = { userId: 111, telegramId: 111n, name: 'Уляна' };
  const orders = { findWithBalance: jest.fn(), findWithBalanceById: jest.fn() };
  const payments = { findById: jest.fn(), attach: jest.fn() };
  const refunds = { refund: jest.fn(), cancelUnpaid: jest.fn() };
  let flow: AdminFlowService;

  const order = (status: OrderStatus, amountPaid: string) => ({
    order: {
      id: 3,
      orderNumber: '0000-066717',
      baseNumber: '0000-066717',
      clientName: 'Петренко',
      amountDue: d('6158.41'),
      status,
      manager: { name: 'Христина' },
    },
    amountPaid: d(amountPaid),
  });
  const unknownPayment = {
    id: 15,
    orderId: null,
    amount: d('2544.09'),
    payerName: 'Сидоренко Олена',
  };

  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [
        AdminFlowService,
        { provide: OrdersService, useValue: orders },
        { provide: PaymentsService, useValue: payments },
        { provide: RefundsService, useValue: refunds },
      ],
    }).compile();

    flow = moduleRef.get(AdminFlowService);
  });

  afterEach(() => jest.resetAllMocks());

  describe('attach', () => {
    it('should ask the admin who pressed the button for the order number', async () => {
      payments.findById.mockResolvedValue(unknownPayment);

      const prompt = await flow.attachPrompt(15, admin);

      expect(prompt.html).toContain('<a href="tg://user?id=111">Уляна</a>');
      expect(prompt.html).toContain("Прив'язка платежу #15");
      expect(prompt.forceReply).toEqual({ placeholder: '0000-066717' });
    });

    it('should not prompt for a payment that is already attached', async () => {
      payments.findById.mockResolvedValue({ ...unknownPayment, orderId: 3 });

      const prompt = await flow.attachPrompt(15, admin);

      expect(prompt.html).toMatch(/^⚠️/);
      expect(prompt.forceReply).toBeUndefined();
    });

    it('should turn the reply to the prompt into a confirmation with the resulting status', async () => {
      payments.findById.mockResolvedValue(unknownPayment);
      orders.findWithBalance.mockResolvedValue(order(OrderStatus.PARTIALLY_PAID, '3614.32'));

      const preview = await flow.answerAttachPrompt(
        "Уляна, 🔗 Прив'язка платежу #15 · 2 544,09 грн · Сидоренко Олена",
        '№А 0000-066717',
      );

      expect(orders.findWithBalance).toHaveBeenCalledWith('№А 0000-066717');
      expect(preview?.html).toContain("Після прив'язки: сплачено 6 158,41 грн → 🟢 Оплачено");
      expect(preview && callbacks(preview)).toEqual(['attach:ok:15:0000-066717', 'admin:dismiss']);
    });

    it('should ignore replies to other messages', async () => {
      await expect(
        flow.answerAttachPrompt('Звичайне повідомлення', '0000-066717'),
      ).resolves.toBeNull();
    });

    it('should refuse to preview an attach to a cancelled order', async () => {
      payments.findById.mockResolvedValue(unknownPayment);
      orders.findWithBalance.mockResolvedValue(order(OrderStatus.CANCELLED, '0'));

      const preview = await flow.attachPreview(15, '0000-066717');

      expect(preview.html).toContain('скасоване');
      expect(preview.buttons).toBeUndefined();
    });

    it('should report the outcome and explain known failures', async () => {
      payments.attach.mockResolvedValue({
        order: { orderNumber: '0000-066717', amountDue: d('6158.41'), status: OrderStatus.PAID },
        amountPaid: d('6158.41'),
      });
      await expect(flow.attach(15, '0000-066717', admin)).resolves.toMatchObject({
        html: expect.stringContaining("✅ Платіж #15 прив'язано") as unknown,
      });

      payments.attach.mockRejectedValue(new PaymentAlreadyAttachedError(15));
      await expect(flow.attach(15, '0000-066717', admin)).resolves.toMatchObject({
        html: expect.stringMatching(/^⚠️ Платіж #15 уже/) as unknown,
      });

      payments.attach.mockRejectedValue(new OrderCancelledError('0000-066717'));
      await expect(flow.attach(15, '0000-066717', admin)).resolves.toMatchObject({
        html: expect.stringContaining('уже скасоване') as unknown,
      });
    });

    it('should rethrow unexpected errors', async () => {
      payments.attach.mockRejectedValue(new Error('db down'));

      await expect(flow.attach(15, '0000-066717', admin)).rejects.toThrow('db down');
    });
  });

  describe('refund', () => {
    it('should offer to return the overpayment, everything, or another amount', async () => {
      orders.findWithBalance.mockResolvedValue(order(OrderStatus.OVERPAID, '6208.41'));

      const menu = await flow.refundMenu('0000-066717');

      expect(menu.html).toContain('Сплачено: 6 208,41 грн');
      expect(callbacks(menu)).toEqual([
        'refund:ask:3:50.00',
        'refund:ask:3:6208.41',
        'refund:part:3',
        'admin:dismiss',
      ]);
    });

    it('should offer cancellation when nothing was paid', async () => {
      orders.findWithBalance.mockResolvedValue(order(OrderStatus.AWAITING_PAYMENT, '0'));

      const menu = await flow.refundMenu('0000-066717');

      expect(callbacks(menu)).toEqual(['refund:void:3', 'admin:dismiss']);
    });

    it('should explain usage without an order number', async () => {
      await expect(flow.refundMenu('  ')).resolves.toMatchObject({
        html: expect.stringContaining('/refund 0000-066717') as unknown,
      });
    });

    it('should show what the order becomes after returning the overpayment', async () => {
      orders.findWithBalanceById.mockResolvedValue(order(OrderStatus.OVERPAID, '6208.41'));

      const confirm = await flow.refundConfirm(3, '50.00');

      expect(confirm.html).toContain(
        'Після повернення: сплачено 6 158,41 грн з 6 158,41 грн → 🟢 Оплачено',
      );
      expect(callbacks(confirm)).toEqual(['refund:ok:3:50.00', 'admin:dismiss']);
    });

    it('should show cancellation when everything is returned', async () => {
      orders.findWithBalanceById.mockResolvedValue(order(OrderStatus.OVERPAID, '6208.41'));

      const confirm = await flow.refundConfirm(3, '6208.41');

      expect(confirm.html).toContain('→ ❌ Скасовано');
    });

    it('should parse the typed amount from a reply to the partial refund prompt', async () => {
      orders.findWithBalance.mockResolvedValue(order(OrderStatus.PAID, '6158.41'));

      const confirm = await flow.answerRefundPrompt(
        'Уляна, ↩️ Часткове повернення · № 0000-066717 · сплачено 6 158,41 грн',
        '1 000,50 грн',
      );

      expect(orders.findWithBalance).toHaveBeenCalledWith('0000-066717');
      expect(confirm && callbacks(confirm)).toEqual(['refund:ok:3:1000.50', 'admin:dismiss']);
    });

    it('should reject a typed amount above what was paid', async () => {
      orders.findWithBalance.mockResolvedValue(order(OrderStatus.PAID, '6158.41'));

      const confirm = await flow.answerRefundPrompt(
        '↩️ Часткове повернення · № 0000-066717',
        '7000',
      );

      expect(confirm?.html).toContain('від 0,01 до 6 158,41 грн');
      expect(confirm?.buttons).toBeUndefined();
    });

    it('should report a stale amount when the balance changed before confirmation', async () => {
      refunds.refund.mockRejectedValue(new RefundAmountError('0000-066717', d('100')));

      const result = await flow.refund(3, '6208.41', admin);

      expect(result.html).toMatch(/^⚠️ Повернути можна від 0,01 до 100 грн/);
    });

    it('should pass the admin as the initiator', async () => {
      refunds.refund.mockResolvedValue({
        order: { orderNumber: '0000-066717', status: OrderStatus.PAID },
        refund: { amount: d('50') },
        amountPaid: d('6158.41'),
      });

      const result = await flow.refund(3, '50.00', admin);

      expect(refunds.refund).toHaveBeenCalledWith(3, '50.00', admin);
      expect(result.html).toContain(
        '✅ Повернення 50 грн за № <b>0000-066717</b> оформлено · Уляна',
      );
    });
  });

  describe('cancel', () => {
    it('should cancel the whole number, not just its first order', async () => {
      refunds.cancelUnpaid.mockResolvedValue({ order: { orderNumber: '0000-066717' } });

      const result = await flow.cancel(3, admin);

      expect(refunds.cancelUnpaid).toHaveBeenCalledWith(3, admin, { wholeNumber: true });
      expect(result.html).toContain('❌ Замовлення № <b>0000-066717</b> скасовано · Уляна');
    });
  });
});
