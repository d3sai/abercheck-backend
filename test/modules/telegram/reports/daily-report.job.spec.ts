import { Test } from '@nestjs/testing';
import { Prisma } from '../../../../src/generated/prisma/client';
import { DailyReportService } from '../../../../src/modules/reports/daily-report.service';
import { DailyReportJob } from '../../../../src/modules/telegram/reports/daily-report.job';
import { TelegramSender } from '../../../../src/modules/telegram/core/telegram-sender';

describe('DailyReportJob', () => {
  const reports = { markUnderpaid: jest.fn(), build: jest.fn() };
  const sender = { send: jest.fn(), sendToAdmins: jest.fn() };
  let job: DailyReportJob;

  const now = new Date('2026-09-11T06:00:00Z');
  const emptyReport = (dayStart: Date) => ({
    dayStart,
    paymentsCount: 0,
    totalAmount: new Prisma.Decimal(0),
    byBucket: {
      AWAITING_PAYMENT: 0,
      PAID: 0,
      PARTIALLY_PAID: 0,
      OVERPAID: 0,
      UNDERPAID: 0,
      CANCELLED: 0,
      UNMATCHED: 0,
    },
    refundsCount: 0,
    refundsAmount: new Prisma.Decimal(0),
  });

  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [
        DailyReportJob,
        { provide: DailyReportService, useValue: reports },
        { provide: TelegramSender, useValue: sender },
      ],
    }).compile();

    job = moduleRef.get(DailyReportJob);
    reports.build.mockImplementation((dayStart: Date) => Promise.resolve(emptyReport(dayStart)));
  });

  afterEach(() => jest.resetAllMocks());

  it('should mark underpaid orders first, notify their managers, then report yesterday', async () => {
    reports.markUnderpaid.mockResolvedValue([
      {
        order: {
          orderNumber: '0000-066717',
          baseNumber: '0000-066717',
          clientName: 'Петренко',
          amountDue: new Prisma.Decimal('100'),
          manager: { name: 'Христина', telegramId: 5000000000n },
        },
        amountPaid: new Prisma.Decimal('40'),
      },
    ]);

    await job.run(now);

    expect(reports.markUnderpaid).toHaveBeenCalledWith(new Date('2026-09-10T21:00:00Z'));
    expect(sender.send).toHaveBeenCalledWith(
      5000000000n,
      expect.stringContaining('Залишок: 60 грн'),
    );
    expect(reports.build).toHaveBeenCalledWith(new Date('2026-09-09T21:00:00Z'));
    expect(sender.sendToAdmins).toHaveBeenCalledWith(
      expect.stringMatching(/Звіт за 10\.09\.2026[\s\S]*Без доплати до кінця дня \(1\)/),
    );
    expect(reports.markUnderpaid.mock.invocationCallOrder[0]).toBeLessThan(
      reports.build.mock.invocationCallOrder[0]!,
    );
  });

  it('should run on schedule with the current time even if cron passes its own arguments', async () => {
    reports.markUnderpaid.mockResolvedValue([]);
    const onSchedule: (...args: unknown[]) => Promise<void> = job.onSchedule.bind(job);

    await onSchedule(() => undefined);

    const [todayStart] = reports.markUnderpaid.mock.calls[0] as [Date];
    expect(todayStart).toBeInstanceOf(Date);
    expect(Number.isNaN(todayStart.getTime())).toBe(false);
    expect(sender.sendToAdmins).toHaveBeenCalledWith(expect.stringContaining('📊'));
  });

  it('should not throw when the report fails', async () => {
    reports.markUnderpaid.mockRejectedValue(new Error('db down'));

    await expect(job.run(now)).resolves.toBeUndefined();
    expect(sender.sendToAdmins).not.toHaveBeenCalled();
  });

  it('should preview yesterday or today without touching statuses', async () => {
    await expect(job.preview(false, now)).resolves.toMatchObject({
      html: expect.stringContaining('Звіт за 10.09.2026') as unknown,
    });
    await expect(job.preview(true, now)).resolves.toMatchObject({
      html: expect.stringContaining('Звіт за сьогодні, 11.09.2026') as unknown,
    });
    expect(reports.markUnderpaid).not.toHaveBeenCalled();
  });
});
