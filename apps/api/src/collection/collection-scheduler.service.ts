import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { PrismaService } from "../database/prisma.service.ts";
import {
  dailyJobKey,
  isDailyScheduleDue,
  parseDailyCron,
  zonedDateParts,
} from "./schedule.ts";

@Injectable()
export class CollectionSchedulerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(CollectionSchedulerService.name);
  private readonly cron = process.env.COLLECTION_CRON ?? "0 3 * * *";
  private readonly timeZone = process.env.APP_TIMEZONE ?? "Europe/Moscow";
  private readonly schedule = parseDailyCron(this.cron);
  private timer?: NodeJS.Timeout;
  private lastCheckedKey?: string;

  constructor(private readonly prisma: PrismaService) {
    zonedDateParts(new Date(), this.timeZone);
  }

  onModuleInit(): void {
    void this.tick();
    this.timer = setInterval(() => void this.tick(), 30_000);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  configuration() {
    return { cron: this.cron, timeZone: this.timeZone, mode: "full" as const };
  }

  async tick(now = new Date()): Promise<void> {
    try {
      const parts = zonedDateParts(now, this.timeZone);
      if (!isDailyScheduleDue(parts, this.schedule)) return;

      const jobKey = dailyJobKey(parts, this.timeZone);
      if (jobKey === this.lastCheckedKey) return;

      const existing = await this.prisma.collectionJob.findUnique({ where: { jobKey } });
      if (existing) {
        this.lastCheckedKey = jobKey;
        return;
      }

      try {
        const job = await this.prisma.collectionJob.create({
          data: {
            jobKey,
            triggerType: "scheduled",
            collectionMode: "full",
            status: "pending",
            scheduledFor: now,
          },
        });
        this.lastCheckedKey = jobKey;
        this.logger.log(`Daily collection job created job_id=${job.id}`);
      } catch (error) {
        const racedJob = await this.prisma.collectionJob.findUnique({ where: { jobKey } });
        if (!racedJob) throw error;
        this.lastCheckedKey = jobKey;
      }
    } catch (error) {
      this.logger.error(
        "Daily collection scheduler failed",
        error instanceof Error ? error.stack : String(error),
      );
    }
  }
}
