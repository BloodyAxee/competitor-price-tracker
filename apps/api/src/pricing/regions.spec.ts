import assert from "node:assert/strict";
import test from "node:test";
import { isRegionCode, REGION_CODES, regionName } from "./regions.ts";

test("regional MVP exposes seven canonical points across Russia", () => {
  assert.deepEqual(REGION_CODES, [
    "moscow",
    "saint-petersburg",
    "kazan",
    "yekaterinburg",
    "krasnodar",
    "novosibirsk",
    "khabarovsk",
  ]);
  assert.equal(regionName("novosibirsk"), "Новосибирск");
});

test("unknown or free-form values cannot become canonical region codes", () => {
  assert.equal(isRegionCode("moscow"), true);
  assert.equal(isRegionCode("Москва"), false);
  assert.equal(isRegionCode(""), false);
  assert.equal(isRegionCode("all-russia"), false);
});
