import { ConsoleLogger, Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { Test, type TestingModule } from '@nestjs/testing';
import { getBotToken, TelegrafModule } from 'nestjs-telegraf';
import { type Telegraf, Telegram } from 'telegraf';
import type { Chat } from 'telegraf/types';
import {
  type Manager,
  ManagerStatus,
  OrderStatus,
  Prisma,
} from '../../../../src/generated/prisma/client';
import { AttachmentsService } from '../../../../src/modules/attachments/attachments.service';
import { ManagersService } from '../../../../src/modules/managers/managers.service';
import {
  type OrderWithManager,
  type OrderWithPaid,
  OrdersService,
} from '../../../../src/modules/orders/orders.service';
import { PaymentsService } from '../../../../src/modules/payments/payments.service';
import { RequisitesService } from '../../../../src/modules/requisites/requisites.service';
import { AdminFlowService } from '../../../../src/modules/telegram/admin/admin-flow.service';
import { AdminUpdate } from '../../../../src/modules/telegram/admin/admin.update';
import { BotUpdate } from '../../../../src/modules/telegram/core/bot.update';
import { MENU_LABEL } from '../../../../src/modules/telegram/core/menu';
import { TelegramSender } from '../../../../src/modules/telegram/core/telegram-sender';
import { OrderDraftService } from '../../../../src/modules/telegram/order-draft/order-draft.service';
import { OrderListService } from '../../../../src/modules/telegram/orders-list/order-list.service';
import { DailyReportJob } from '../../../../src/modules/telegram/reports/daily-report.job';

const ADMIN_CHAT_ID = -1002286861249;
const MANAGER_ID = 111;
const STRANGER_ID = 222;

const manager = {
  id: 1,
  telegramId: BigInt(MANAGER_ID),
  name: 'Христина',
  status: ManagerStatus.ACTIVE,
} as Manager;

const openOrder = {
  order: {
    orderNumber: '0000-066717',
    baseNumber: '0000-066717',
    status: OrderStatus.PARTIALLY_PAID,
    amountDue: new Prisma.Decimal('6158.41'),
    clientName: 'Чернявський Владислав',
    createdAt: new Date('2026-09-03T09:00:00Z'),
    manager,
  },
  amountPaid: new Prisma.Decimal('3000'),
} as OrderWithPaid<OrderWithManager>;

const ordersMock = {
  list: () => Promise.resolve({ items: [openOrder], total: 1 }),
  findWithBalance: jest.fn(),
  create: jest.fn(),
  createGroup: jest.fn(),
};

const requisitesMock = { addMany: jest.fn(), list: jest.fn() };

@Module({
  providers: [
    BotUpdate,
    AdminUpdate,
    TelegramSender,
    OrderDraftService,
    OrderListService,
    {
      provide: ManagersService,
      useValue: {
        findActiveByTelegramId: (telegramId: bigint) =>
          Promise.resolve(telegramId === manager.telegramId ? manager : null),
        requestAccess: () => Promise.resolve({ manager, isNew: false }),
      },
    },
    { provide: OrdersService, useValue: ordersMock },
    { provide: RequisitesService, useValue: requisitesMock },
    {
      provide: PaymentsService,
      useValue: { findUnmatched: () => Promise.resolve({ payments: [], total: 0 }) },
    },
    { provide: AttachmentsService, useValue: {} },
    { provide: AdminFlowService, useValue: {} },
    { provide: DailyReportJob, useValue: {} },
  ],
})
class BotTestModule {}

interface SendMessagePayload {
  text: string;
  reply_markup?: {
    keyboard?: { text: string }[][];
    inline_keyboard?: { text: string; callback_data?: string }[][];
  };
}

interface DeliverOptions {
  chat?: Chat;
  fromId?: number;
}

const privateChat = (id: number): Chat.PrivateChat => ({
  id,
  type: 'private',
  first_name: 'Христина',
});
const adminGroup: Chat.SupergroupChat = { id: ADMIN_CHAT_ID, type: 'supergroup', title: 'Адміни' };

const menuOf = ({ reply_markup }: SendMessagePayload) =>
  reply_markup?.keyboard?.flat().map((button) => button.text);

describe('BotUpdate', () => {
  let moduleRef: TestingModule;
  let bot: Telegraf;
  let sent: SendMessagePayload[] = [];
  let edited: SendMessagePayload[] = [];
  let loggedErrors: jest.SpyInstance;
  let updateId = 0;

  beforeEach(async () => {
    sent = [];
    edited = [];
    ordersMock.findWithBalance.mockReset();
    ordersMock.create.mockReset();
    ordersMock.createGroup.mockReset();
    requisitesMock.addMany.mockReset();
    requisitesMock.list.mockReset().mockResolvedValue([]);
    loggedErrors = jest.spyOn(ConsoleLogger.prototype, 'error').mockImplementation(() => undefined);
    jest.spyOn(Telegram.prototype, 'callApi').mockImplementation(((
      method: string,
      payload: SendMessagePayload,
    ) => {
      if (method === 'sendMessage') {
        sent.push(payload);
      }
      if (method === 'editMessageText') {
        edited.push(payload);
      }
      return Promise.resolve(true);
    }) as never);

    moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          ignoreEnvFile: true,
          load: [
            () => ({
              TELEGRAM_BOT_TOKEN: '123456:TESTTESTTESTTESTTESTTESTTESTTEST',
              TELEGRAM_ADMIN_CHAT_ID: ADMIN_CHAT_ID,
            }),
          ],
        }),
        TelegrafModule.forRootAsync({
          inject: [ConfigService],
          useFactory: (config: ConfigService) => ({
            token: config.getOrThrow<string>('TELEGRAM_BOT_TOKEN'),
            include: [BotTestModule],
            launchOptions: false,
          }),
        }),
        BotTestModule,
      ],
    }).compile();
    await moduleRef.init();

    bot = moduleRef.get<Telegraf>(getBotToken(), { strict: false });
    bot.botInfo = { id: 999, is_bot: true, first_name: 'Бот', username: 'test_bot' } as never;
    jest.spyOn(bot, 'stop').mockImplementation(() => undefined);
  });

  afterEach(async () => {
    await moduleRef.close();
    jest.restoreAllMocks();
  });

  const deliver = async (
    message: Record<string, unknown>,
    options: DeliverOptions = {},
  ): Promise<SendMessagePayload[]> => {
    const { chat = privateChat(MANAGER_ID), fromId = MANAGER_ID } = options;
    sent = [];
    await bot.handleUpdate({
      update_id: ++updateId,
      message: {
        message_id: updateId,
        date: 0,
        chat,
        from: { id: fromId, is_bot: false, first_name: 'Христина' },
        ...message,
      },
    } as never);
    expect(loggedErrors).not.toHaveBeenCalled();
    return sent;
  };

  const press = async (data: string, fromId = MANAGER_ID): Promise<void> => {
    sent = [];
    edited = [];
    await bot.handleUpdate({
      update_id: ++updateId,
      callback_query: {
        id: `cb-${updateId}`,
        chat_instance: 'instance',
        data,
        from: { id: fromId, is_bot: false, first_name: 'Христина' },
        message: {
          message_id: updateId,
          date: 0,
          chat: privateChat(fromId),
          text: 'offer',
        },
      },
    });
    expect(loggedErrors).not.toHaveBeenCalled();
  };

  const say = (text: string, options?: DeliverOptions) =>
    deliver(
      text.startsWith('/')
        ? {
            text,
            entities: [
              {
                type: 'bot_command',
                offset: 0,
                length: !text.includes(' ') ? text.length : text.indexOf(' '),
              },
            ],
          }
        : { text },
      options,
    );

  const sendPdf = () =>
    deliver({
      document: {
        file_id: 'file-1',
        file_unique_id: 'unique-1',
        file_name: 'invoice.pdf',
        mime_type: 'application/pdf',
        file_size: 1000,
      },
    });

  describe('the main menu', () => {
    it.each(['/start', '/help', 'привіт'])(
      'should show the five buttons in reply to %s',
      async (text) => {
        const replies = await say(text);

        expect(replies).toHaveLength(1);
        expect(menuOf(replies[0]!)).toHaveLength(5);
        expect(menuOf(replies[0]!)).toEqual(Object.values(MENU_LABEL));
      },
    );
  });

  describe('a menu button pressed in a private chat', () => {
    it('should answer "new order" with the regular order format', async () => {
      const replies = await say(MENU_LABEL.NewOrder);

      expect(replies).toHaveLength(1);
      expect(replies[0]!.text).toContain('Нове замовлення');
      expect(replies[0]!.text).toContain('Номер*');
    });

    it('should answer "close minus" with the format that has no order number', async () => {
      const replies = await say(MENU_LABEL.NewMinus);

      expect(replies).toHaveLength(1);
      expect(replies[0]!.text).toContain('Закриття мінусу');
      expect(replies[0]!.text).not.toContain('Номер');
    });

    it('should answer "list" with the manager\'s open orders', async () => {
      const replies = await say(MENU_LABEL.List);

      expect(replies).toHaveLength(1);
      expect(replies[0]!.text).toContain('Мої відкриті замовлення');
      expect(replies[0]!.text).toContain('0000-066717');
    });

    it('should say there is nothing to cancel when no files are pending', async () => {
      const replies = await say(MENU_LABEL.Cancel);

      expect(replies.map(({ text }) => text)).toEqual(['Нема чого скасовувати.']);
    });

    it('should forget the attached files on "cancel"', async () => {
      const attached = await sendPdf();
      const cancelled = await say(MENU_LABEL.Cancel);

      expect(attached[0]!.text).toContain('invoice.pdf');
      expect(cancelled.map(({ text }) => text)).toEqual(['Скасовано.']);
      expect((await say(MENU_LABEL.Cancel)).map(({ text }) => text)).toEqual([
        'Нема чого скасовувати.',
      ]);
    });

    it('should send someone who is not a manager to /start', async () => {
      const replies = await say(MENU_LABEL.List, {
        chat: privateChat(STRANGER_ID),
        fromId: STRANGER_ID,
      });

      expect(replies).toHaveLength(1);
      expect(replies[0]!.text).toContain('/start');
    });
  });

  describe('a menu button label typed in the admin group', () => {
    it.each(Object.values(MENU_LABEL))('should ignore %s', async (label) => {
      expect(await say(label, { chat: adminGroup })).toEqual([]);
    });
  });

  describe('another part of a number that is already taken', () => {
    const existing = {
      order: {
        orderNumber: '0000-066717',
        baseNumber: '0000-066717',
        clientName: 'Чернявський Владислав',
        amountDue: new Prisma.Decimal('6158.41'),
      },
      amountPaid: new Prisma.Decimal('0'),
    };
    const message = ['0000-066717', 'Другий ФОП', '1 000,00 грн'].join('\n');
    const createdPart = {
      id: 2,
      orderNumber: '0000-066717(1)',
      baseNumber: '0000-066717',
      clientName: 'Другий ФОП',
      amountDue: new Prisma.Decimal('1000'),
      orderType: 'REGULAR',
      status: OrderStatus.AWAITING_PAYMENT,
    };

    beforeEach(() => ordersMock.findWithBalance.mockResolvedValue(existing));

    it('should ask for confirmation with two buttons instead of creating a duplicate', async () => {
      const replies = await say(message);

      expect(replies).toHaveLength(1);
      expect(replies[0]!.text).toContain('вже є в системі');
      expect(
        replies[0]!.reply_markup?.inline_keyboard?.flat().map((button) => button.callback_data),
      ).toEqual(['part:add', 'part:skip']);
      expect(ordersMock.create).not.toHaveBeenCalled();
    });

    it('should add the part when the manager presses the button', async () => {
      ordersMock.create.mockResolvedValue(createdPart);
      await say(message);

      await press('part:add');

      expect(ordersMock.create).toHaveBeenCalledWith(
        1,
        expect.objectContaining({ orderNumber: '0000-066717', clientName: 'Другий ФОП' }),
        { notify: true, addPart: true },
      );
      expect(edited).toHaveLength(1);
      expect(edited[0]!.text).toContain('0000-066717(1)');
    });

    it('should drop the draft when the manager declines, and not add it later', async () => {
      await say(message);

      await press('part:skip');
      expect(edited.map(({ text }) => text)).toEqual(['Скасовано.']);

      await press('part:add');
      expect(edited[0]!.text).toContain('Немає даних');
      expect(ordersMock.create).not.toHaveBeenCalled();
    });

    it('should not let someone who is not a manager add anything', async () => {
      await press('part:add', STRANGER_ID);

      expect(sent[0]!.text).toContain('/start');
      expect(edited).toHaveLength(0);
      expect(ordersMock.create).not.toHaveBeenCalled();
    });
  });

  describe('one message: "кілька номерів / реквізити", armed by /requisites', () => {
    const GROUP = `0000-068772 335,58 грн.
0000-068773 971,83 грн.
0000-068774 605,41 грн.
Загальна сума: 1 912,82 грн

18.09.2026 21:28
Гук Віктор Степанович ФОП
44,9%`;
    const groupOrders = () =>
      [
        ['0000-068772', '335.58'],
        ['0000-068773', '971.83'],
        ['0000-068774', '605.41'],
      ].map(([number, amount]) => ({
        id: 1,
        orderNumber: number,
        baseNumber: '0000-068772',
        clientName: 'Гук Віктор Степанович ФОП',
        amountDue: new Prisma.Decimal(amount!),
        orderType: 'REGULAR',
        status: OrderStatus.AWAITING_PAYMENT,
        createdAt: new Date('2026-09-18T21:28:00Z'),
      }));

    it.each(['/requisites', MENU_LABEL.Requisites])(
      'should show the format hint and arm waiting for the very next message in reply to %s',
      async (text) => {
        const replies = await say(text);

        expect(replies[0]!.text).toContain('одним повідомленням');
        expect(replies[0]!.reply_markup?.inline_keyboard).toBeUndefined();
      },
    );

    it('should refuse a payment-report-shaped message with guidance when /requisites was never sent', async () => {
      const replies = await say(GROUP);

      expect(replies[0]!.text).not.toContain('кілька номерів однією оплатою');
      expect(replies[0]!.text).toContain('кілька номерів або оплату на чужі реквізити');
      expect(replies[0]!.text).toContain(MENU_LABEL.Requisites);
      expect(replies[0]!.text).toContain('/requisites');
      expect(ordersMock.createGroup).not.toHaveBeenCalled();
    });

    it('should show a preview and create the group only after "Надіслати"', async () => {
      ordersMock.findWithBalance.mockResolvedValue(null);
      ordersMock.createGroup.mockResolvedValue(groupOrders());
      await say('/requisites');

      const preview = await say(GROUP);

      expect(preview[0]!.text).toContain('кілька номерів однією оплатою');
      expect(preview[0]!.reply_markup?.inline_keyboard?.flat().map((b) => b.callback_data)).toEqual(
        ['req:ok', 'req:edit', 'req:regular'],
      );
      expect(ordersMock.createGroup).not.toHaveBeenCalled();

      await press('req:ok');

      expect(ordersMock.createGroup).toHaveBeenCalledTimes(1);
      expect(edited[0]!.text).toContain('зареєстровано');
    });

    it('should wait for a corrected message after "Виправити"', async () => {
      await say('/requisites');
      await say(GROUP);

      await press('req:edit');
      expect(edited[0]!.text).toContain('Надішліть виправлене');

      await press('req:ok');
      expect(edited[0]!.text).toContain('Немає даних');
      expect(ordersMock.createGroup).not.toHaveBeenCalled();
    });

    it('should drop a pending preview once /new is used instead', async () => {
      await say('/requisites');
      await say(GROUP);

      await say('/new');
      await press('req:ok');

      expect(edited[0]!.text).toContain('Немає даних');
      expect(ordersMock.createGroup).not.toHaveBeenCalled();
    });

    it('should not let someone who is not a manager use it', async () => {
      const replies = await say('/requisites', {
        chat: privateChat(STRANGER_ID),
        fromId: STRANGER_ID,
      });

      expect(replies[0]!.text).toContain('/start');
    });
  });
});
