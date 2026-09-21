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
    status: OrderStatus.PARTIALLY_PAID,
    amountDue: new Prisma.Decimal('6158.41'),
    clientName: 'Чернявський Владислав',
    createdAt: new Date('2026-09-03T09:00:00Z'),
    manager,
  },
  amountPaid: new Prisma.Decimal('3000'),
} as OrderWithPaid<OrderWithManager>;

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
    {
      provide: OrdersService,
      useValue: { list: () => Promise.resolve({ items: [openOrder], total: 1 }) },
    },
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
  reply_markup?: { keyboard?: { text: string }[][] };
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
  let loggedErrors: jest.SpyInstance;
  let updateId = 0;

  beforeEach(async () => {
    sent = [];
    loggedErrors = jest.spyOn(ConsoleLogger.prototype, 'error').mockImplementation(() => undefined);
    jest.spyOn(Telegram.prototype, 'callApi').mockImplementation(((
      method: string,
      payload: SendMessagePayload,
    ) => {
      if (method === 'sendMessage') {
        sent.push(payload);
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

  const say = (text: string, options?: DeliverOptions) =>
    deliver(
      text.startsWith('/')
        ? { text, entities: [{ type: 'bot_command', offset: 0, length: text.length }] }
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
      'should show the four buttons in reply to %s',
      async (text) => {
        const replies = await say(text);

        expect(replies).toHaveLength(1);
        expect(menuOf(replies[0]!)).toHaveLength(4);
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
});
