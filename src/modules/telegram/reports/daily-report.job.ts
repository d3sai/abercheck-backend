import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { KYIV_TIME_ZONE, kyivDayStart, previousKyivDayStart } from '../../../common/kyiv-time';
import { DailyReportService } from '../../reports/daily-report.service';
import type { BotReply } from '../core/bot-reply';
import { dailyReportMessage, underpaidMessage } from './report.messages';
import { TelegramSender } from '../core/telegram-sender';

@Injectable()
export class DailyReportJob {
  private readonly logger = new Logger(DailyReportJob.name);

  constructor(
    private readonly reports: DailyReportService,
    private readonly sender: TelegramSender,
  ) {}

  @Cron('0 9 * * *', { name: 'daily-report', timeZone: KYIV_TIME_ZONE })
  async onSchedule(): Promise<void> {
    await this.run(new Date());
  }

  async run(now: Date): Promise<void> {
    try {
      const todayStart = kyivDayStart(now);
      const underpaid = await this.reports.markUnderpaid(todayStart);
      for (const item of underpaid) {
        await this.sender.send(item.order.manager.telegramId, underpaidMessage(item));
      }

      const report = await this.reports.build(previousKyivDayStart(todayStart));
      await this.sender.sendToTopic('reports', dailyReportMessage(report, underpaid));
      this.logger.log(`Daily report sent, ${underpaid.length} orders marked underpaid`);
    } catch (error) {
      this.logger.error('Daily report failed', error);
    }
  }

  async preview(today: boolean, now = new Date()): Promise<BotReply> {
    const todayStart = kyivDayStart(now);
    const dayStart = today ? todayStart : previousKyivDayStart(todayStart);
    const report = await this.reports.build(dayStart);
    return { html: dailyReportMessage(report, [], today ? 'Звіт за сьогодні,' : 'Звіт за') };
  }
}
