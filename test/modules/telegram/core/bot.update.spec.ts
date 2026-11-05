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
import {
  CashDraftService,
  CashDraftStore,
} from '../../../../src/modules/telegram/order-draft/cash-draft.service';
import { ReportedPaymentService } from '../../../../src/modules/telegram/order-draft/reported-payment.service';
import { DraftAttachmentNotifier } from '../../../../src/modules/telegram/order-draft/draft-attachment-notifier';
import {
  ForeignDraftService,
  ForeignDraftStore,
} from '../../../../src/modules/telegram/order-draft/foreign-draft.service';
import {
  KitDraftService,
  KitDraftStore,
} from '../../../../src/modules/telegram/order-draft/kit-draft.service';
import { OrderDraftService } from '../../../../src/modules/telegram/order-draft/order-draft.service';
import { PendingFilesStore } from '../../../../src/modules/telegram/order-draft/pending-files.store';
import { PrismaService } from '../../../../src/common/prisma/prisma.service';
import { OrderDeleteService } from '../../../../src/modules/telegram/orders-list/order-delete.service';
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
    PendingFilesStore,
    KitDraftService,
    KitDraftStore,
    CashDraftService,
    CashDraftStore,
    ForeignDraftService,
    ForeignDraftStore,
    ReportedPaymentService,
    DraftAttachmentNotifier,
    OrderListService,
    { provide: OrderDeleteService, useValue: {} },
    { provide: PrismaService, useValue: {} },
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
      'should show the six buttons in reply to %s',
      async (text) => {
        const replies = await say(text);

        expect(replies).toHaveLength(1);
        expect(menuOf(replies[0]!)).toHaveLength(6);
        expect(menuOf(replies[0]!)).toEqual(Object.values(MENU_LABEL));
      },
    );
  });

  describe('a menu button pressed in a private chat', () => {
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
      await say(MENU_LABEL.Kit);
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

  describe('outside an armed mode', () => {
    it('should answer a file with the help and the menu, without storing it', async () => {
      const replies = await sendPdf();

      expect(replies).toHaveLength(1);
      expect(replies[0]!.text).toContain('Новий запит');
      expect(menuOf(replies[0]!)).toEqual(Object.values(MENU_LABEL));
      expect((await say(MENU_LABEL.Cancel)).map(({ text }) => text)).toEqual([
        'Нема чого скасовувати.',
      ]);
    });

    it('should not create anything from a pasted order', async () => {
      const replies = await say('0000-066717\nЧернявський Владислав\n6 158,41 грн');

      expect(menuOf(replies[0]!)).toEqual(Object.values(MENU_LABEL));
      expect(ordersMock.create).not.toHaveBeenCalled();
    });

    it('should keep accepting files inside /kit', async () => {
      await say('/kit');

      const replies = await sendPdf();

      expect(replies[0]!.text).toContain('invoice.pdf');
    });
  });
});

describe('BotUpdate bootstrap', () => {
  const build = (miniAppUrl?: string) => {
    const sender = {
      miniAppUrl,
      adminChatId: ADMIN_CHAT_ID,
      registerCommands: jest.fn().mockResolvedValue(undefined),
      setDefaultMenuButton: jest.fn().mockResolvedValue(undefined),
    };
    const update = new BotUpdate(
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      sender as unknown as TelegramSender,
    );
    return { sender, update };
  };

  it('should make «Новий запит» the default menu button when MINI_APP_URL is set', async () => {
    const { sender, update } = build('https://cab.example.ua/tg/request');

    await update.onApplicationBootstrap();

    expect(sender.setDefaultMenuButton).toHaveBeenCalledTimes(1);
    expect(sender.setDefaultMenuButton).toHaveBeenCalledWith({
      text: '📝 Новий запит',
      url: 'https://cab.example.ua/tg/request',
    });
  });

  it('should reset the menu button to the commands menu without MINI_APP_URL', async () => {
    const { sender, update } = build();

    await update.onApplicationBootstrap();

    expect(sender.setDefaultMenuButton).toHaveBeenCalledWith(null);
    expect(sender.registerCommands).toHaveBeenCalledTimes(2);
  });

  it('should not register the commands of the removed modes', async () => {
    const { sender, update } = build();

    await update.onApplicationBootstrap();

    const [commands] = (sender.registerCommands.mock.calls as [{ command: string }[]][])[0]!;
    const names = commands.map(({ command }) => command);
    expect(names).toEqual(['kit', 'cash', 'foreign', 'requests', 'list', 'cancel', 'help']);
  });
});
