import { Logger } from '@nestjs/common';
import type { FinanceRequestCard } from '../../../src/generated/prisma/client';
import {
  FinanceApiError,
  type FinanceRequestView,
} from '../../../src/modules/finance-sync/finance.types';
import { OrderDeletedListener } from '../../../src/modules/finance-sync/order-deleted.listener';

const card = {
  requestId: 'req1',
  number: '42',
  managerId: 4,
  orderIds: [10, 11],
} as FinanceRequestCard;

const cancelledView = { id: 'req1', number: '42', status: 'cancelled' } as FinanceRequestView;

describe('OrderDeletedListener', () => {
  const cards = { byOrderId: jest.fn() };
  const orders = { numbersByIds: jest.fn() };
  const managers = { findById: jest.fn() };
  const finance = { cancel: jest.fn() };
  const sync = { renderManager: jest.fn(), renderGroup: jest.fn() };
  const listener = new OrderDeletedListener(
    cards as never,
    orders as never,
    managers as never,
    finance as never,
    sync as never,
  );
  let error: jest.SpyInstance;

  beforeEach(() => {
    cards.byOrderId.mockResolvedValue(card);
    orders.numbersByIds.mockResolvedValue([]);
    managers.findById.mockResolvedValue({ telegramId: 555n, name: 'Іван Петренко' });
    finance.cancel.mockResolvedValue(cancelledView);
    error = jest.spyOn(Logger.prototype, 'error').mockImplementation();
  });
  afterEach(() => {
    jest.resetAllMocks();
    error.mockRestore();
  });

  it('should cancel the finance request as its manager once its last order is deleted', async () => {
    await listener.onDeleted({ orderId: 11 });

    expect(cards.byOrderId).toHaveBeenCalledWith(11);
    expect(orders.numbersByIds).toHaveBeenCalledWith([10, 11]);
    expect(finance.cancel).toHaveBeenCalledWith('req1', {
      actorTelegramId: 555,
      actorName: 'Іван Петренко',
    });
    expect(sync.renderManager).toHaveBeenCalledWith(card, cancelledView);
    expect(sync.renderGroup).toHaveBeenCalledWith(card, cancelledView);
  });

  it('should keep the request while another of its orders is alive', async () => {
    orders.numbersByIds.mockResolvedValue(['0000-10']);

    await listener.onDeleted({ orderId: 11 });

    expect(finance.cancel).not.toHaveBeenCalled();
  });

  it('should do nothing for an order that came from no request', async () => {
    cards.byOrderId.mockResolvedValue(null);

    await listener.onDeleted({ orderId: 11 });

    expect(finance.cancel).not.toHaveBeenCalled();
  });

  it('should log, not throw, when finance refuses the cancel', async () => {
    finance.cancel.mockRejectedValue(new FinanceApiError(409, 'already-closed'));

    await expect(listener.onDeleted({ orderId: 11 })).resolves.toBeUndefined();

    expect(sync.renderManager).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalled();
  });
});
