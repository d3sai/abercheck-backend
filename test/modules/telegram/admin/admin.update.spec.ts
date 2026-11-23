import { ManagerRole } from '../../../../src/generated/prisma/client';
import type { ManagersService } from '../../../../src/modules/managers/managers.service';
import type { AdminFlowService } from '../../../../src/modules/telegram/admin/admin-flow.service';
import { AdminUpdate } from '../../../../src/modules/telegram/admin/admin.update';
import type { DailyReportJob } from '../../../../src/modules/telegram/reports/daily-report.job';
import type { TelegramSender } from '../../../../src/modules/telegram/core/telegram-sender';
import type { OrderVerificationService } from '../../../../src/modules/telegram/verification/order-verification.service';

const ADMIN_CHAT_ID = -1002286861249;

describe('AdminUpdate', () => {
  const flow = {
    refundMenu: jest.fn(),
    answerAttachPrompt: jest.fn(),
    answerRefundPrompt: jest.fn(),
  };
  const reports = { preview: jest.fn() };
  const sender = { adminChatId: ADMIN_CHAT_ID };
  const managers = { findActiveByTelegramId: jest.fn() };
  const verification = {
    verify: jest.fn(),
    undo: jest.fn(),
    problem: jest.fn(),
    reasons: jest.fn(),
    back: jest.fn(),
  };
  let update: AdminUpdate;

  beforeEach(() => {
    update = new AdminUpdate(
      flow as unknown as AdminFlowService,
      reports as unknown as DailyReportJob,
      sender as unknown as TelegramSender,
      managers as unknown as ManagersService,
      verification as unknown as OrderVerificationService,
    );
  });

  afterEach(() => jest.resetAllMocks());

  const ctx = (overrides: { chatId?: number; fromId?: number } = {}) => ({
    chat: { id: overrides.chatId ?? ADMIN_CHAT_ID },
    from: { id: overrides.fromId ?? 555, first_name: 'Уляна' },
    payload: '',
    reply: jest.fn(),
    answerCbQuery: jest.fn(),
    editMessageText: jest.fn(),
    editMessageReplyMarkup: jest.fn(),
  });

  describe('a /report command from the admin chat', () => {
    it('should run for an active ADMIN', async () => {
      managers.findActiveByTelegramId.mockResolvedValue({ role: ManagerRole.ADMIN });
      reports.preview.mockResolvedValue({ html: 'report' });
      const next = jest.fn();

      await update.report(ctx() as never, next);

      expect(managers.findActiveByTelegramId).toHaveBeenCalledWith(555n);
      expect(reports.preview).toHaveBeenCalled();
      expect(next).not.toHaveBeenCalled();
    });

    it('should fall through, without a DB lookup, when the chat is not the admin chat', async () => {
      const next = jest.fn();

      await update.report(ctx({ chatId: 1 }) as never, next);

      expect(managers.findActiveByTelegramId).not.toHaveBeenCalled();
      expect(reports.preview).not.toHaveBeenCalled();
      expect(next).toHaveBeenCalled();
    });

    it('should fall through when the sender has no active manager record', async () => {
      managers.findActiveByTelegramId.mockResolvedValue(null);
      const next = jest.fn();

      await update.report(ctx() as never, next);

      expect(reports.preview).not.toHaveBeenCalled();
      expect(next).toHaveBeenCalled();
    });

    it('should fall through for an active MANAGER who is not an ADMIN', async () => {
      managers.findActiveByTelegramId.mockResolvedValue({ role: ManagerRole.MANAGER });
      const next = jest.fn();

      await update.report(ctx() as never, next);

      expect(reports.preview).not.toHaveBeenCalled();
      expect(next).toHaveBeenCalled();
    });
  });

  describe('an inline action from the admin chat', () => {
    it('should show an alert instead of running the action for a non-admin', async () => {
      managers.findActiveByTelegramId.mockResolvedValue(null);
      const c = ctx();

      await update.dismiss(c as never);

      expect(c.answerCbQuery).toHaveBeenCalledWith(
        'Ця дія доступна лише активним адміністраторам.',
      );
      expect(c.editMessageText).not.toHaveBeenCalled();
    });

    it('should run for an active ADMIN', async () => {
      managers.findActiveByTelegramId.mockResolvedValue({ role: ManagerRole.ADMIN });
      const c = ctx();

      await update.dismiss(c as never);

      expect(c.editMessageText).toHaveBeenCalled();
    });
  });

  describe('a text reply to a bot prompt', () => {
    const replyCtx = (overrides: { chatId?: number; fromId?: number } = {}) => ({
      ...ctx(overrides),
      message: { reply_to_message: { from: { id: 42 }, text: "Прив'язка платежу #1" } },
      text: '0000-066717',
      botInfo: { id: 42 },
    });

    it('should not touch the database for a message that is not a reply to the bot', async () => {
      const next = jest.fn();
      const c = { ...replyCtx(), message: { text: 'hello' } };

      await update.answer(c as never, next);

      expect(managers.findActiveByTelegramId).not.toHaveBeenCalled();
      expect(next).toHaveBeenCalled();
    });

    it('should resolve the prompt for an active ADMIN', async () => {
      managers.findActiveByTelegramId.mockResolvedValue({ role: ManagerRole.ADMIN });
      flow.answerAttachPrompt.mockResolvedValue({ html: 'ok' });
      const next = jest.fn();

      await update.answer(replyCtx() as never, next);

      expect(flow.answerAttachPrompt).toHaveBeenCalled();
      expect(next).not.toHaveBeenCalled();
    });

    it('should fall through when the admin has no open prompt, so other handlers see the reply', async () => {
      managers.findActiveByTelegramId.mockResolvedValue({ role: ManagerRole.ADMIN });
      flow.answerAttachPrompt.mockResolvedValue(null);
      flow.answerRefundPrompt.mockResolvedValue(null);
      const next = jest.fn();

      await update.answer(replyCtx() as never, next);

      expect(next).toHaveBeenCalled();
    });

    it('should fall through for a manager who is not an admin', async () => {
      managers.findActiveByTelegramId.mockResolvedValue({ role: ManagerRole.MANAGER });
      const next = jest.fn();

      await update.answer(replyCtx() as never, next);

      expect(flow.answerAttachPrompt).not.toHaveBeenCalled();
      expect(next).toHaveBeenCalled();
    });
  });

  describe('the verify buttons', () => {
    const buttons = [[{ text: 'x', callback_data: 'vf:undo:7' }]];
    const press = (data: string) => {
      const match = [
        /^vf:ok:(\d+)$/,
        /^vf:bad:(\d+)$/,
        /^vf:r:(\d+):([a-z]+)$/,
        /^vf:undo:(\d+)$/,
        /^vf:back:(\d+)$/,
      ]
        .map((re) => re.exec(data))
        .find(Boolean)!;
      return { ...ctx(), match };
    };
    const asAdmin = () =>
      managers.findActiveByTelegramId.mockResolvedValue({ role: ManagerRole.ADMIN });

    it('should refuse a manager who is not an admin', async () => {
      managers.findActiveByTelegramId.mockResolvedValue({ role: ManagerRole.MANAGER });
      const c = press('vf:ok:7');

      await update.verifyOk(c as never);

      expect(c.answerCbQuery).toHaveBeenCalledWith(
        'Ця дія доступна лише активним адміністраторам.',
      );
      expect(verification.verify).not.toHaveBeenCalled();
    });

    it('should swap the buttons after «Звірено»', async () => {
      asAdmin();
      verification.verify.mockResolvedValue({ buttons });
      const c = press('vf:ok:7');

      await update.verifyOk(c as never);

      expect(verification.verify).toHaveBeenCalledWith(
        7,
        expect.objectContaining({ telegramId: 555n, name: 'Уляна' }),
      );
      expect(c.editMessageReplyMarkup).toHaveBeenCalledWith({ inline_keyboard: buttons });
      expect(c.answerCbQuery).toHaveBeenCalledWith();
    });

    it('should alert an error and keep the buttons', async () => {
      asAdmin();
      verification.undo.mockResolvedValue({ error: '⚠️ Замовлення не знайдено' });
      const c = press('vf:undo:7');

      await update.verifyUndo(c as never);

      expect(c.answerCbQuery).toHaveBeenCalledWith('⚠️ Замовлення не знайдено', {
        show_alert: true,
      });
      expect(c.editMessageReplyMarkup).not.toHaveBeenCalled();
    });

    it('should open the reasons and go back', async () => {
      asAdmin();
      verification.reasons.mockResolvedValue({ buttons });
      verification.back.mockResolvedValue({ buttons });

      await update.verifyBad(press('vf:bad:7') as never);
      await update.verifyBack(press('vf:back:7') as never);

      expect(verification.reasons).toHaveBeenCalledWith(7);
      expect(verification.back).toHaveBeenCalledWith(7);
    });

    it('should store the reason', async () => {
      asAdmin();
      verification.problem.mockResolvedValue({ buttons, delivered: true });
      const c = press('vf:r:7:processing');

      await update.verifyReason(c as never);

      expect(verification.problem).toHaveBeenCalledWith(
        7,
        'processing',
        expect.objectContaining({ telegramId: 555n, name: 'Уляна' }),
      );
      expect(c.editMessageReplyMarkup).toHaveBeenCalledWith({ inline_keyboard: buttons });
      expect(c.answerCbQuery).toHaveBeenCalledWith();
    });

    it('should say when the manager was not reached', async () => {
      asAdmin();
      verification.problem.mockResolvedValue({ buttons, delivered: false });
      const c = press('vf:r:7:sum');

      await update.verifyReason(c as never);

      expect(c.answerCbQuery).toHaveBeenCalledWith('Менеджеру не доставлено', { show_alert: true });
      expect(c.editMessageReplyMarkup).toHaveBeenCalled();
    });

    it('should ignore an unknown reason code', async () => {
      asAdmin();
      const c = press('vf:r:7:xyz');

      await update.verifyReason(c as never);

      expect(verification.problem).not.toHaveBeenCalled();
      expect(c.answerCbQuery).toHaveBeenCalledWith();
    });

    it('should still answer the press when the buttons cannot be changed', async () => {
      asAdmin();
      verification.verify.mockResolvedValue({ buttons });
      const c = press('vf:ok:7');
      c.editMessageReplyMarkup.mockRejectedValue(
        new Error('400: Bad Request: message to edit not found'),
      );

      await expect(update.verifyOk(c as never)).resolves.toBe(undefined);
      expect(c.answerCbQuery).toHaveBeenCalled();
    });

    it('should not fail when the buttons are already the same', async () => {
      asAdmin();
      verification.verify.mockResolvedValue({ buttons });
      const c = press('vf:ok:7');
      c.editMessageReplyMarkup.mockRejectedValue(
        new Error('400: Bad Request: message is not modified'),
      );

      await expect(update.verifyOk(c as never)).resolves.toBe(undefined);
    });
  });
});
