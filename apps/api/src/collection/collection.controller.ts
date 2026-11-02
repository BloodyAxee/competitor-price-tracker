import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
} from "@nestjs/common";
import { z } from "zod";
import { CollectionSchedulerService } from "./collection-scheduler.service.ts";
import { createCollectionJobSchema } from "./collection-mode.ts";
import { CollectionService } from "./collection.service.ts";

const jobQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
  status: z.enum(["pending", "running", "partial_success", "success", "failed"]).optional(),
});
const jobIdSchema = z.string().uuid();

@Controller("api")
export class CollectionController {
  constructor(
    private readonly collection: CollectionService,
    private readonly scheduler: CollectionSchedulerService,
  ) {}

  @Post("collection-jobs")
  @HttpCode(202)
  createJob(@Body() rawBody: unknown) {
    const parsed = createCollectionJobSchema.safeParse(rawBody ?? {});
    if (!parsed.success) throw new BadRequestException(parsed.error.flatten());
    return this.collection.createManualJob(parsed.data.mode);
  }

  @Get("collection-jobs")
  jobs(@Query() rawQuery: Record<string, unknown>) {
    const parsed = jobQuerySchema.safeParse(rawQuery);
    if (!parsed.success) throw new BadRequestException(parsed.error.flatten());
    return this.collection.jobs(parsed.data);
  }

  @Get("collection-jobs/:id")
  job(@Param("id") rawId: string) {
    const parsed = jobIdSchema.safeParse(rawId);
    if (!parsed.success) throw new BadRequestException("Invalid collection job id");
    return this.collection.job(parsed.data);
  }

  @Get("collection-schedule")
  schedule() {
    return this.scheduler.configuration();
  }
}
