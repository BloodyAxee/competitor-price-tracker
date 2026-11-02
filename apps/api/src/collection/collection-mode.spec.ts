import assert from "node:assert/strict";
import test from "node:test";
import { createCollectionJobSchema } from "./collection-mode.ts";

test("manual collection defaults to fast mode", () => {
  assert.deepEqual(createCollectionJobSchema.parse({}), { mode: "fast" });
});

test("full collection must be requested explicitly", () => {
  assert.deepEqual(createCollectionJobSchema.parse({ mode: "full" }), { mode: "full" });
  assert.equal(createCollectionJobSchema.safeParse({ mode: "unknown" }).success, false);
  assert.equal(createCollectionJobSchema.safeParse({ mode: "full", extra: true }).success, false);
});
