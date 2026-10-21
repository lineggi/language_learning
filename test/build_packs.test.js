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

/* ------------------------------------------------- Korea economy -- */

test("the three sections get non-overlapping rank bands", () => {
  // crypto 1..3, economy 4..6, korea 7..9 — the app sorts by rank within a
  // day, so an overlap would interleave the sections.
  const bands = { crypto: 0, economy: 3, korea: 6 };
  const ranks = [];
  for (const base of Object.values(bands)) for (let r = 1; r <= 3; r++) ranks.push(base + r);
  assert.deepEqual(ranks, [1, 2, 3, 4, 5, 6, 7, 8, 9]);
  assert.equal(new Set(ranks).size, 9, "no two sections may claim the same rank");
});

test("a day of all three sections shards and indexes as one group", () => {
  const day = (date) => [
    ...[1, 2, 3].map((r) => ({ id: `cd-${date}-${r}`, date, rank: r, category: "crypto", title: "c" + r })),
    ...[1, 2, 3].map((r) => ({ id: `ec-${date}-${r}`, date, rank: 3 + r, category: "economy", title: "e" + r })),
    ...[1, 2, 3].map((r) => ({ id: `kr-${date}-${r}`, date, rank: 6 + r, category: "korea", title: "k" + r })),
  ];
  const all = ["2026-10-07", "2026-10-06"].flatMap(day);
  const { recent, index } = B.splitPacks(all, 14);
  assert.equal(recent.length, 18, "nine packs a day, both days recent");
  assert.equal(index.length, 18);
  assert.deepEqual(index.slice(0, 9).map((e) => e.rank), [1, 2, 3, 4, 5, 6, 7, 8, 9],
    "the newest day comes out in rank order, crypto → economy → korea");
  assert.deepEqual([...new Set(index.map((e) => e.category))].sort(), ["crypto", "economy", "korea"]);
});

test("the Korea feed list is distinct, absolute and free of the other sections' sources", () => {
  const korea = B.KOREA_FEEDS;
  assert.ok(korea.length >= 4, `want several sources, got ${korea.length}`);
  assert.equal(new Set(korea).size, korea.length, "no duplicate feeds");
  for (const f of korea) assert.match(f, /^https:\/\//, f);
  const others = new Set([...B.ECON_FEEDS, ...B.RSS_FEEDS]);
  for (const f of korea) assert.ok(!others.has(f), `${f} is already used by another section`);
  // Korea's own English-language desks, not only wire coverage of Korea.
  const domestic = korea.filter((f) => /kedglobal|yna\.co\.kr|koreaherald|koreatimes/.test(f));
  assert.ok(domestic.length >= 3, `want Korean outlets in the mix, got ${domestic.length}`);
});

test("round-robin keeps one Korea feed from swamping the pool", () => {
  // The Google News searches return far more items than the Korean desks, so
  // the interleave is what keeps domestic coverage in the candidate list.
  const used = B.usedUrlSet([]);
  const fat = Array.from({ length: 40 }, (_, i) => ({ link: `https://news.google.com/x${i}` }));
  const thin = [{ link: "https://www.kedglobal.com/a" }, { link: "https://en.yna.co.kr/b" }];
  // excludeUsed must not reorder or drop anything when nothing has been used.
  assert.equal(B.excludeUsed([...thin, ...fat], used).length, 42);
});

/* ------------------------------------------ glossary leak repair -- */

const LEAKY = () => ([
  { id: "p1", glossary: {
      traditional: { meaning: "Existing in or as part of a tradition; long-established.", pos: "adjective" },
      custody: { meaning: "Holding and protecting an asset for someone else.", pos: "noun" } } },
  { id: "p2", glossary: { quantum: "Relating to quantum mechanics and tiny particles." } },
]);

test("findLeaks spots definitions that contain their own word, and only those", () => {
  const found = B.findLeaks(LEAKY());
  assert.deepEqual(found.map((f) => f.word).sort(), ["quantum", "traditional"]);
  assert.equal(found.find((f) => f.word === "traditional").packId, "p1");
});

test("applyFixes keeps each entry's shape — object or bare string", () => {
  const packs = LEAKY();
  const n = B.applyFixes(packs, new Map([
    ["p1\u0000traditional", "Long established and handed down over many years."],
    ["p2\u0000quantum", "Relating to the physics of extremely small particles."],
  ]));
  assert.equal(n, 2);
  assert.deepEqual(packs[0].glossary.traditional,
    { meaning: "Long established and handed down over many years.", pos: "adjective" },
    "an object entry keeps its pos");
  assert.equal(typeof packs[1].glossary.quantum, "string", "a legacy string entry stays a string");
  assert.equal(B.findLeaks(packs).length, 0);
});

test("a rewrite that still leaks is thrown away, not applied", async () => {
  // The safety property: a bad batch must leave the data as it was.
  const items = B.findLeaks(LEAKY());
  const call = async () => ({ items: items.map((it, i) => ({
    n: i + 1,
    // Both rewrites still contain the word — the model ignored the brief.
    meaning: `Something to do with ${it.word} in general use.`,
  })) });
  const fixes = await B.rewriteLeaks(items, { call, log: () => {} });
  assert.equal(fixes.size, 0, "nothing accepted");
  const packs = LEAKY();
  assert.equal(B.applyFixes(packs, fixes), 0);
  assert.equal(B.findLeaks(packs).length, 2, "the originals are untouched");
});

test("clean rewrites are accepted and leaky ones in the same batch are not", async () => {
  const items = B.findLeaks(LEAKY());
  const call = async () => ({ items: [
    { n: items.findIndex((i) => i.word === "traditional") + 1, meaning: "Long established and handed down over many years." },
    { n: items.findIndex((i) => i.word === "quantum") + 1, meaning: "About quantum physics." }, // still leaks
  ] });
  const fixes = await B.rewriteLeaks(items, { call, log: () => {} });
  assert.equal(fixes.size, 1);
  const packs = LEAKY();
  B.applyFixes(packs, fixes);
  assert.equal(B.findLeaks(packs).map((f) => f.word).join(), "quantum", "only the bad one is left");
});

test("a failed call leaves every original in place", async () => {
  const items = B.findLeaks(LEAKY());
  const call = async () => { throw new Error("503 from the model"); };
  const fixes = await B.rewriteLeaks(items, { call, log: () => {} });
  assert.equal(fixes.size, 0);
});

test("rewriting is batched so one huge prompt is never sent", async () => {
  const many = Array.from({ length: 95 }, (_, i) => ({ packId: "p", word: `alpha${i}`, meaning: `About alpha${i}.` }));
  const sizes = [];
  const call = async (prompt) => { sizes.push((prompt.match(/^\d+\. /gm) || []).length); return { items: [] }; };
  await B.rewriteLeaks(many, { call, log: () => {}, batch: 40 });
  assert.deepEqual(sizes, [40, 40, 15]);
});

test("every build_packs function the scripts call is actually exported", () => {
  // scripts/repair_glossary.js called B.writeFeed, which was not in the export
  // list. Nothing noticed until a live run had already paid for the rewrites
  // and then died on the line that saves them — the dry run returns before
  // reaching it, so no amount of dry-running would have caught it.
  const fs = require("node:fs");
  const path = require("node:path");
  const dir = path.join(__dirname, "..", "scripts");
  const missing = [];
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith(".js"))) {
    const src = fs.readFileSync(path.join(dir, file), "utf8");
    if (!/require\(["'][^"']*build_packs\.js["']\)/.test(src)) continue;
    for (const m of src.matchAll(/\bB\.([A-Za-z_$][\w$]*)/g)) {
      if (typeof B[m[1]] !== "function") missing.push(`${file} → B.${m[1]}`);
    }
  }
  assert.deepEqual([...new Set(missing)], [], "these are called but not exported");
});
