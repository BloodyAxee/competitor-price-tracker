import assert from "node:assert/strict";
import test from "node:test";
import { dailyJobKey, isDailyScheduleDue, parseDailyCron, zonedDateParts } from "./schedule.ts";

test("daily cron parser accepts only one fixed time per day", () => {
  assert.deepEqual(parseDailyCron("0 3 * * *"), { minute: 0, hour: 3 });
  assert.throws(() => parseDailyCron("*/5 * * * *"));
  assert.throws(() => parseDailyCron("0 25 * * *"));
});

test("Europe Moscow schedule becomes due after the configured local time", () => {
  const before = zonedDateParts(new Date("2026-11-01T23:59:00Z"), "Europe/Moscow");
  const after = zonedDateParts(new Date("2026-11-02T00:01:00Z"), "Europe/Moscow");

  assert.equal(isDailyScheduleDue(before, parseDailyCron("0 3 * * *")), false);
  assert.equal(isDailyScheduleDue(after, parseDailyCron("0 3 * * *")), true);
  assert.equal(dailyJobKey(after, "Europe/Moscow"), "daily:Europe/Moscow:2026-11-02");
});
