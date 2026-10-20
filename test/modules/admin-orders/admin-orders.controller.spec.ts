import { AdminOrdersController } from '../../../src/modules/admin-orders/admin-orders.controller';

describe('AdminOrdersController', () => {
  const service = { preview: jest.fn(), remove: jest.fn() };
  const controller = new AdminOrdersController(service as never);
  const dto = { confirm: '1234-567890', payments: 'detach' as const };

  afterEach(() => jest.resetAllMocks());

  it('should pass the number to preview', async () => {
    service.preview.mockResolvedValue({ order_number: '1234-567890' });

    await expect(controller.preview('1234-567890')).resolves.toEqual({
      order_number: '1234-567890',
    });
    expect(service.preview).toHaveBeenCalledWith('1234-567890');
  });

  it('should pass number, dto and the trimmed actor to remove', async () => {
    await controller.remove('1234-567890', dto, `  ${'a'.repeat(100)}  `);

    expect(service.remove).toHaveBeenCalledWith('1234-567890', dto, 'a'.repeat(64));
  });

  it("should default the actor to 'unknown'", async () => {
    await controller.remove('1234-567890', dto, undefined);

    expect(service.remove).toHaveBeenCalledWith('1234-567890', dto, 'unknown');
  });
});
