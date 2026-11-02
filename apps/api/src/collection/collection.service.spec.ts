import assert from "node:assert/strict";
import test from "node:test";
import { CollectionService } from "./collection.service.ts";

test("manual jobs persist the requested collection mode", async () => {
  let createdData: Record<string, unknown> | undefined;
  const prisma = {
    collectionJob: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        createdData = data;
        return {
          id: "00000000-0000-0000-0000-000000000001",
          jobKey: null,
          triggerType: data.triggerType,
          collectionMode: data.collectionMode,
          status: data.status,
          scheduledFor: data.scheduledFor,
          startedAt: null,
          finishedAt: null,
          summary: {},
          createdAt: new Date("2026-11-02T12:00:00Z"),
        };
      },
    },
  };

  const result = await new CollectionService(prisma as never).createManualJob("full");

  assert.equal(createdData?.collectionMode, "full");
  assert.equal(result.collectionMode, "full");
});
