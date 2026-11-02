import assert from "node:assert/strict";
import test from "node:test";
import { CollectionSchedulerService } from "./collection-scheduler.service.ts";

test("daily scheduler does not duplicate a job after an API restart", async () => {
  const jobs = new Map<string, { id: string; jobKey: string }>();
  let createCalls = 0;
  let createdMode: string | undefined;
  const prisma = {
    collectionJob: {
      findUnique: async ({ where }: { where: { jobKey: string } }) =>
        jobs.get(where.jobKey) ?? null,
      create: async ({ data }: { data: { jobKey: string; collectionMode: string } }) => {
        createCalls += 1;
        createdMode = data.collectionMode;
        const job = { id: `job-${createCalls}`, jobKey: data.jobKey };
        jobs.set(data.jobKey, job);
        return job;
      },
    },
  };
  const dueTime = new Date("2026-11-02T01:00:00Z");

  await new CollectionSchedulerService(prisma as never).tick(dueTime);
  await new CollectionSchedulerService(prisma as never).tick(dueTime);

  assert.equal(createCalls, 1);
  assert.equal(jobs.size, 1);
  assert.equal(createdMode, "full");
});
