import { HttpStatus, Logger } from '@nestjs/common';
import { ApiError } from '../../../src/common/api-error';
import type { Manager } from '../../../src/generated/prisma/client';
import type { ManagersService } from '../../../src/modules/managers/managers.service';
import { MiniappUpdate } from '../../../src/modules/miniapp/miniapp.update';
import type { RequestCompletionService } from '../../../src/modules/miniapp/request-completion.service';
import { NOT_A_MANAGER } from '../../../src/modules/telegram/access/access.messages';

const manager = { id: 4, telegramId: 555n, name: 'Уляна' } as Manager;

describe('MiniappUpdate', () => {
  const completion = { accept: jest.fn() };
  const managers = { findActiveByTelegramId: jest.fn() };
  const update = new MiniappUpdate(
    completion as unknown as RequestCompletionService,
    managers as unknown as ManagersService,
  );

  const press = (type = 'private') => ({
    chat: { id: 555, type },
    from: { id: 555 },
    match: ['mo:req1', 'req1'],
    answerCbQuery: jest.fn(),
  });

  beforeEach(() => {
    managers.findActiveByTelegramId.mockResolvedValue(manager);
    jest.spyOn(Logger.prototype, 'error').mockImplementation();
  });
  afterEach(() => {
    jest.resetAllMocks();
    jest.restoreAllMocks();
  });

  it('should accept the request of the manager who pressed and answer', async () => {
    completion.accept.mockResolvedValue({ orderNumbers: ['0000-1'], skipped: [] });
    const c = press();

    await update.accept(c as never);

    expect(managers.findActiveByTelegramId).toHaveBeenCalledWith(555n);
    expect(completion.accept).toHaveBeenCalledWith(manager, 'req1');
    expect(c.answerCbQuery).toHaveBeenCalledWith('✅ Оформлено');
  });

  it('should show a note of a partial result as an alert', async () => {
    completion.accept.mockResolvedValue({ orderNumbers: ['0000-1'], skipped: [], note: 'Нотатка' });
    const c = press();

    await update.accept(c as never);

    expect(c.answerCbQuery).toHaveBeenCalledWith('Нотатка', { show_alert: true });
  });

  it('should ignore a press outside a private chat', async () => {
    const c = press('supergroup');

    await update.accept(c as never);

    expect(completion.accept).not.toHaveBeenCalled();
    expect(c.answerCbQuery).not.toHaveBeenCalled();
  });

  it('should refuse a user who is not a manager', async () => {
    managers.findActiveByTelegramId.mockResolvedValue(null);
    const c = press();

    await update.accept(c as never);

    expect(completion.accept).not.toHaveBeenCalled();
    expect(c.answerCbQuery).toHaveBeenCalledWith(NOT_A_MANAGER.slice(0, 200), {
      show_alert: true,
    });
  });

  it('should alert the message of a refusal, e.g. a double press', async () => {
    completion.accept.mockRejectedValue(
      new ApiError(HttpStatus.CONFLICT, 'already-completed', 'Запит уже оформлено'),
    );
    const c = press();

    await update.accept(c as never);

    expect(c.answerCbQuery).toHaveBeenCalledWith('Запит уже оформлено', { show_alert: true });
  });

  it('should point to «Змінити» when the number exists and a part has to be agreed', async () => {
    completion.accept.mockRejectedValue(
      new ApiError(HttpStatus.CONFLICT, 'order-exists-part', 'Номер 0000-1 уже є в системі.'),
    );
    const c = press();

    await update.accept(c as never);

    expect(c.answerCbQuery).toHaveBeenCalledWith(
      'Номер 0000-1 уже є в системі. Відкрийте «✏️ Змінити».',
      { show_alert: true },
    );
  });

  it('should answer a failure it does not know, so the button never hangs', async () => {
    completion.accept.mockRejectedValue(new Error('db down'));
    const c = press();

    await update.accept(c as never);

    expect(c.answerCbQuery).toHaveBeenCalledWith('Не вдалося, спробуйте ще раз', {
      show_alert: true,
    });
  });
});
