import assert from "node:assert/strict";

const args = process.argv.slice(2);

function option(name, fallback = undefined) {
  const index = args.indexOf(name);
  if (index === -1) return fallback;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
}

const apiOrigin = option("--api", process.env.ACCEPTANCE_API_ORIGIN ?? "http://localhost:3000");
const webOrigin = option("--web", process.env.ACCEPTANCE_WEB_ORIGIN ?? "http://localhost:5173");
const jobId = option("--job", process.env.ACCEPTANCE_JOB_ID);
const expectedExactOffers = Number(option("--exact-offers", process.env.ACCEPTANCE_EXACT_OFFERS ?? "64"));
const expectedComparableOffers = Number(
  option("--comparable-offers", process.env.ACCEPTANCE_COMPARABLE_OFFERS ?? "4"),
);

assert.ok(Number.isInteger(expectedExactOffers) && expectedExactOffers > 0, "exact offer count must be positive");
assert.ok(
  Number.isInteger(expectedComparableOffers) && expectedComparableOffers > 0,
  "comparable offer count must be positive",
);

async function response(path, origin = apiOrigin) {
  const result = await fetch(new URL(path, origin), { signal: AbortSignal.timeout(15_000) });
  assert.equal(result.ok, true, `${result.url} returned HTTP ${result.status}`);
  return result;
}

async function json(path) {
  return (await response(path)).json();
}

function assertNoZeroPrices(value, location = "response") {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoZeroPrices(item, `${location}[${index}]`));
    return;
  }
  if (!value || typeof value !== "object") return;

  for (const [key, child] of Object.entries(value)) {
    if ((key === "rawPrice" || key === "normalizedPrice") && child !== null) {
      assert.ok(Number(child) > 0, `${location}.${key} must be positive when present`);
    }
    assertNoZeroPrices(child, `${location}.${key}`);
  }
}

const health = await json("/health");
assert.equal(health.status, "ok");

const summary = await json("/api/catalog/summary");
assert.deepEqual(
  {
    total: summary.total,
    required: summary.required,
    additional: summary.additional,
    ownUrls: summary.ownUrls,
    exactOffers: summary.exactOffers,
    comparableOffers: summary.comparableOffers,
    reviewOffers: summary.reviewOffers,
  },
  {
    total: 267,
    required: 29,
    additional: 236,
    ownUrls: 28,
    exactOffers: expectedExactOffers,
    comparableOffers: expectedComparableOffers,
    reviewOffers: 91 - expectedExactOffers - expectedComparableOffers,
  },
);

const products = await json("/api/products?scope=required&limit=500");
assert.equal(products.total, 29);
assert.equal(products.items.length, 29);
assert.equal(products.items.filter((product) => product.ownUrl).length, 28);
assert.equal(products.items.filter((product) => product.bundleParts.length === 2).length, 1);

const comparisons = await json("/api/comparisons?scope=required&limit=500");
assert.equal(comparisons.total, 29);
assert.equal(comparisons.items.length, 29);
assertNoZeroPrices(comparisons);

const csvResponse = await response("/api/export.csv");
assert.match(csvResponse.headers.get("content-type") ?? "", /^text\/csv/);
const csv = (await csvResponse.text()).replace(/^\uFEFF/, "");
assert.equal(
  csv.split(/\r?\n/, 1)[0],
  "model,nash_url,konkurent,konkurent_url,cena,cena_za,data_sbora,sposob,nadezhnost,kommentariy",
);
if (jobId) assert.ok(csv.split(/\r?\n/).length > 29, "CSV must contain collected observations");

const schedule = await json("/api/collection-schedule");
assert.deepEqual(schedule, { cron: "0 3 * * *", timeZone: "Europe/Moscow", mode: "full" });

const webResponse = await response("/", webOrigin);
const html = await webResponse.text();
assert.match(html, /<div id="root"><\/div>/);

let checkedJob = null;
if (jobId) {
  const job = await json(`/api/collection-jobs/${encodeURIComponent(jobId)}`);
  assert.ok(["success", "partial_success"].includes(job.status), "job must be terminal and usable");
  assert.equal(job.summary.total, job.summary.succeeded + job.summary.failed + job.summary.skipped);
  assert.equal(job.observations, job.summary.succeeded);
  assert.ok(job.attempts.every((attempt) => !["pending", "running"].includes(attempt.status)));

  if (job.status === "partial_success") {
    assert.ok(job.summary.succeeded > 0, "a partial job must retain successful sources");
    assert.ok(job.summary.failed > 0, "a partial job must expose failed sources");
    assert.ok(job.observations > 0, "failed sources must not discard successful observations");
  }

  checkedJob = {
    id: job.id,
    status: job.status,
    total: job.summary.total,
    succeeded: job.summary.succeeded,
    failed: job.summary.failed,
    observations: job.observations,
  };
}

console.log(
  JSON.stringify({
    status: "ok",
    catalog: {
      total: summary.total,
      required: summary.required,
      exactOffers: summary.exactOffers,
      comparableOffers: summary.comparableOffers,
      reviewOffers: summary.reviewOffers,
    },
    job: checkedJob,
  }),
);
