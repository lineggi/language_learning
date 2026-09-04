const { test } = require("node:test");
const assert = require("node:assert/strict");
const B = require("../build_packs.js");

const pack = (date, rank, extra = {}) => ({
  id: `cd-${date}-${rank}`, date, rank, category: "crypto",
  title: `T${rank}`, source: "src", url: `https://x/${date}/${rank}`,
  passage: "x".repeat(500), glossary: {}, questions: [], modelAnswers: [], ...extra,
});
const days = (from, n) => Array.from({ length: n }, (_, i) => {
  const d = new Date(Date.parse(from + "T00:00:00Z") + i * 86400000);
  return d.toISOString().slice(0, 10);
});

test("dedupeById keeps the first copy, so a rebuild overwrites the old one", () => {
  const out = B.dedupeById([pack("2026-09-04", 1, { title: "fresh" }), pack("2026-09-04", 1, { title: "stale" })]);
  assert.equal(out.length, 1);
  assert.equal(out[0].title, "fresh");
});

test("splitPacks cuts by day, never leaving a day half-archived", () => {
  const all = days("2026-08-01", 20).flatMap((d) => [pack(d, 1), pack(d, 2)]);
  const { recent, shards, index } = B.splitPacks(all, 14);

  assert.equal(index.length, 40, "the index covers every pack ever");
  assert.equal(recent.length, 28, "14 days x 2 packs stay in packs.json");

  const recentDates = new Set(recent.map((p) => p.date));
  assert.equal(recentDates.size, 14);
  assert.ok(recentDates.has("2026-08-20"), "the newest day is recent");
  assert.ok(!recentDates.has("2026-08-06"), "day 15 back is archived");

  const archived = Object.values(shards).flat();
  assert.equal(archived.length, 12);
  const overlap = archived.filter((p) => recentDates.has(p.date));
  assert.deepEqual(overlap, [], "no day appears on both sides of the cut");
});

test("splitPacks shards by month and orders newest first", () => {
  const all = [...days("2026-07-28", 10).map((d) => pack(d, 1)), ...days("2026-09-01", 3).map((d) => pack(d, 1))];
  const { shards, index } = B.splitPacks(all, 2);
  // Only 09-03 and 09-02 stay recent, so 09-01 lands in its own month shard.
  assert.deepEqual(Object.keys(shards).sort(), ["2026-07", "2026-08", "2026-09"]);
  assert.ok(shards["2026-07"].every((p) => p.date.startsWith("2026-07")));
  assert.equal(index[0].date, "2026-09-03", "newest first");
});

test("index rows are metadata only — no passage, glossary or questions", () => {
  const e = B.indexEntry(pack("2026-09-04", 2));
  assert.deepEqual(Object.keys(e).sort(), ["category", "date", "id", "rank", "source", "title"]);
  assert.ok(JSON.stringify(e).length < 250, "a row must stay small: the index holds every pack ever");
});

test("everything in packs.json plus the shards is reachable through the index", () => {
  const all = days("2026-08-01", 30).map((d) => pack(d, 1));
  const { recent, shards, index } = B.splitPacks(all, 14);
  const ids = new Set(index.map((e) => e.id));
  for (const p of [...recent, ...Object.values(shards).flat()]) {
    assert.ok(ids.has(p.id), `${p.id} missing from the index`);
  }
  assert.equal(ids.size, index.length, "no duplicate rows");
});

test("an id carries the date its shard is named after", () => {
  // The app derives the shard filename from the id when the index hasn't loaded.
  const p = pack("2026-07-15", 3);
  assert.equal(B.shardOf(p), "2026-07");
  assert.equal(p.id.match(/(\d{4}-\d{2})-\d{2}/)[1], B.shardOf(p));
});

test("usedUrlSet / excludeUsed keep the daily feed off yesterday's stories", () => {
  const used = B.usedUrlSet([{ url: "https://a.com/one?utm=x" }, { url: "https://b.com/two/" }]);
  const cands = [
    { link: "https://A.com/one" },        // same story, different case + query
    { link: "https://b.com/two" },        // same story, trailing slash
    { link: "https://c.com/three" },
    { link: "https://d.com/four" },
    { link: "https://e.com/five" },
  ];
  assert.deepEqual(B.excludeUsed(cands, used).map((c) => c.link),
    ["https://c.com/three", "https://d.com/four", "https://e.com/five"]);
});

test("excludeUsed tops back up rather than starving a build", () => {
  const used = B.usedUrlSet([{ url: "https://a.com/one" }, { url: "https://b.com/two" }]);
  const cands = [{ link: "https://a.com/one" }, { link: "https://b.com/two" }, { link: "https://c.com/three" }];
  const out = B.excludeUsed(cands, used);
  assert.equal(out.length, 3, "fewer than minKeep fresh → reuse, freshest first");
  assert.equal(out[0].link, "https://c.com/three");
});

test("tidyMeaning trims runaway text at a word boundary, not mid-word", () => {
  const short = "채권을 사고파는 시장";
  assert.equal(B.tidyMeaning(short), short, "short meanings pass through untouched");
  assert.equal(B.tidyMeaning("  spaced   out  "), "spaced out");
  const long = B.tidyMeaning(("word ".repeat(60)).trim());
  assert.ok(long.length <= 145, `got ${long.length}`);
  assert.ok(long.endsWith("…"));
  assert.ok(long.slice(0, -1).split(" ").every((w) => w === "word"), "never cuts a word in half");
});

test("kstDateString labels a 21:00 UTC build with the KST day it belongs to", () => {
  // This is the mismatch the workflow's commit message used to have.
  assert.equal(B.kstDateString(new Date("2026-09-03T21:00:00Z")), "2026-09-04");
  assert.equal(B.kstDateString(new Date("2026-09-04T14:59:00Z")), "2026-09-04");
});
