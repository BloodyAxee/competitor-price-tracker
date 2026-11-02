import { Injectable, NotFoundException } from "@nestjs/common";
import { PrismaService } from "../database/prisma.service.ts";
import type { CollectionMode } from "./collection-mode.ts";

export interface JobQuery {
  limit: number;
  offset: number;
  status?: "pending" | "running" | "partial_success" | "success" | "failed";
}

function jobSummary(job: {
  id: string;
  jobKey: string | null;
  triggerType: string;
  collectionMode: string;
  status: string;
  scheduledFor: Date | null;
  startedAt: Date | null;
  finishedAt: Date | null;
  summary: unknown;
  createdAt: Date;
  _count?: { attempts: number; observations: number };
}) {
  return {
    id: job.id,
    jobKey: job.jobKey,
    triggerType: job.triggerType,
    collectionMode: job.collectionMode,
    status: job.status,
    scheduledFor: job.scheduledFor,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    summary: job.summary,
    createdAt: job.createdAt,
    attempts: job._count?.attempts,
    observations: job._count?.observations,
  };
}

@Injectable()
export class CollectionService {
  constructor(private readonly prisma: PrismaService) {}

  async createManualJob(mode: CollectionMode = "fast") {
    const job = await this.prisma.collectionJob.create({
      data: {
        triggerType: "manual",
        collectionMode: mode,
        status: "pending",
        scheduledFor: new Date(),
      },
    });
    return jobSummary(job);
  }

  async jobs(query: JobQuery) {
    const where = query.status ? { status: query.status } : {};
    const [total, items] = await Promise.all([
      this.prisma.collectionJob.count({ where }),
      this.prisma.collectionJob.findMany({
        where,
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        skip: query.offset,
        take: query.limit,
        include: { _count: { select: { attempts: true, observations: true } } },
      }),
    ]);
    return { total, items: items.map(jobSummary), limit: query.limit, offset: query.offset };
  }

  async job(id: string) {
    const job = await this.prisma.collectionJob.findUnique({
      where: { id },
      include: {
        _count: { select: { attempts: true, observations: true } },
        attempts: {
          orderBy: [{ source: { externalKey: "asc" } }, { attemptNumber: "asc" }],
          include: {
            source: { select: { externalKey: true, name: true } },
            offer: {
              select: {
                id: true,
                competitorUrl: true,
                product: { select: { id: true, name: true } },
              },
            },
            observations: { select: { id: true, reliability: true } },
          },
        },
      },
    });
    if (!job) throw new NotFoundException("Collection job not found");

    return {
      ...jobSummary(job),
      attempts: job.attempts.map((attempt) => ({
        id: attempt.id.toString(),
        attemptNumber: attempt.attemptNumber,
        method: attempt.method,
        status: attempt.status,
        httpStatus: attempt.httpStatus,
        errorCode: attempt.errorCode,
        errorMessage: attempt.errorMessage,
        startedAt: attempt.startedAt,
        finishedAt: attempt.finishedAt,
        source: attempt.source,
        offer: attempt.offer,
        observations: attempt.observations.map((observation) => ({
          id: observation.id.toString(),
          reliability: observation.reliability,
        })),
      })),
    };
  }
}
