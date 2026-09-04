const { test } = require("node:test");
const assert = require("node:assert/strict");
const S = require("../lib/state.js");

const DAY = 86400000;
// A fixed "now" so nothing here depends on the day the suite happens to run.
const AT = (ymd) => Date.parse(ymd + "T00:00:00Z") - 9 * 3600 * 1000; // KST midnight

/* -------------------------------------------------------------- dates -- */

test("kstToday rolls over at 15:00 UTC, not midnight UTC", () => {
  assert.equal(S.kstToday(Date.parse("2026-09-04T14:59:00Z")), "2026-09-04");
  assert.equal(S.kstToday(Date.parse("2026-09-04T15:00:00Z")), "2026-09-05");
  assert.equal(S.kstToday(AT("2026-09-05")), "2026-09-05");
});

test("daysBetween counts calendar days in either direction", () => {
  assert.equal(S.daysBetween("2026-09-01", "2026-09-04"), 3);
  assert.equal(S.daysBetween("2026-09-04", "2026-09-01"), -3);
  assert.equal(S.daysBetween("2026-09-04", "2026-09-04"), 0);
  assert.equal(S.daysBetween("2026-02-28", "2026-03-01"), 1); // 2026 is not a leap year
});

test("monthDays pads to the correct starting weekday", () => {
  // 2026-09-01 is a Tuesday → one blank cell for Monday... and Sunday-first
  // grids mean two leading blanks.
  const cells = S.monthDays("2026-09");
  assert.equal(cells.filter((c) => c === null).length, new Date(Date.UTC(2026, 8, 1)).getUTCDay());
  assert.equal(cells.filter(Boolean).length, 30);
  assert.equal(cells[cells.length - 1], "2026-09-30");
});

test("shiftMonth crosses year boundaries", () => {
  assert.equal(S.shiftMonth("2026-01", -1), "2025-12");
  assert.equal(S.shiftMonth("2026-12", 1), "2027-01");
});

/* ------------------------------------------------------------- streak -- */

test("a streak survives yesterday but breaks after a skipped day", () => {
  const kept = S.normalizeStreak({ count: 7, lastDate: "2026-09-03", days: [] }, "2026-09-04");
  assert.equal(kept.count, 7);
  const broken = S.normalizeStreak({ count: 7, lastDate: "2026-09-01", days: [] }, "2026-09-04");
  assert.equal(broken.count, 0, "more than one day of silence ends the streak");
  assert.equal(broken.lastDate, "2026-09-01", "lastDate is kept for the calendar");
});

test("normalizeStreak backfills lastDate into the days log", () => {
  const v = S.normalizeStreak({ count: 3, lastDate: "2026-09-04", days: [] }, "2026-09-04");
  assert.deepEqual(v.days, ["2026-09-04"]);
});

test("a decayed local streak beats a stale higher remote count", () => {
  // The regression from 679aba9: remote still holds 12 from before the break.
  const local = { count: 0, lastDate: "2026-08-20", days: ["2026-08-20"] };
  const remote = { count: 12, lastDate: "2026-08-20", days: ["2026-08-19", "2026-08-20"] };
  const picked = S.pickStreak(local, remote, "2026-09-04");
  assert.equal(picked.count, 0, "both sides are normalized before comparing");
  assert.deepEqual(picked.days, ["2026-08-19", "2026-08-20"], "days is a union, not a winner-takes-all");
});

test("a genuinely longer streak wins, and days unions both devices", () => {
  const picked = S.pickStreak(
    { count: 2, lastDate: "2026-09-04", days: ["2026-09-03", "2026-09-04"] },
    { count: 5, lastDate: "2026-09-04", days: ["2026-09-01"] },
    "2026-09-04"
  );
  assert.equal(picked.count, 5);
  assert.deepEqual(picked.days, ["2026-09-01", "2026-09-03", "2026-09-04"]);
});

test("bumpStreak is once per day and resets after a gap", () => {
  let st = S.bumpStreak(null, "2026-09-01");
  assert.equal(st.count, 1);
  st = S.bumpStreak(st, "2026-09-01");
  assert.equal(st.count, 1, "a second word the same day does not bump");
  st = S.bumpStreak(st, "2026-09-02");
  assert.equal(st.count, 2);
  st = S.bumpStreak(st, "2026-09-05");
  assert.equal(st.count, 1, "a skipped day restarts at 1");
  assert.deepEqual(st.days, ["2026-09-01", "2026-09-02", "2026-09-05"]);
});

/* ---------------------------------------------------------------- SRS -- */

test("stageOf migrates the legacy learned flag", () => {
  assert.equal(S.stageOf({}), "new");
  assert.equal(S.stageOf({ learned: true }), "review");
  assert.equal(S.stageOf({ learned: true, stage: "mastered" }), "mastered", "explicit stage wins");
});

test("a 복습중 word is due after REVIEW_DUE_DAYS and stays due forever", () => {
  const w = { stage: "review", reviewSince: "2026-09-01" };
  assert.equal(S.reviewDue(w, "2026-09-03"), false);
  assert.equal(S.reviewDue(w, "2026-09-04"), true);
  // c92061d / 1269f96: an overdue word must NOT fall back to 미암기.
  assert.equal(S.reviewDue(w, "2026-12-31"), true, "no upper bound — it just stays due");
  assert.equal(S.reviewDue({ stage: "mastered", reviewSince: "2026-01-01" }, "2026-09-04"), false);
});

test("classifyWord tells a new word from one already collected or mastered", () => {
  const bank = {
    apple: { stage: "new" },
    pear: { stage: "mastered" },
    plum: { stage: "review", deleted: true },
  };
  assert.equal(S.classifyWord(bank, "apple"), "exists");
  assert.equal(S.classifyWord(bank, "APPLE"), "exists", "lookup is case-insensitive");
  assert.equal(S.classifyWord(bank, "pear"), "mastered");
  assert.equal(S.classifyWord(bank, "plum"), "new", "a soft-deleted word is collectable again");
  assert.equal(S.classifyWord(bank, "quince"), "new");
});

/* ------------------------------------------------------------- merges -- */

test("mergeWordbank folds casing variants into one entry", () => {
  const merged = S.mergeWordbank({ Vanguard: { meaning: "a", updatedAt: 2 } }, { vanguard: { meaning: "b", updatedAt: 1 } });
  assert.deepEqual(Object.keys(merged), ["vanguard"]);
  assert.equal(merged.vanguard.meaning, "a");
});

test("mergeWordbank is last-write-wins but keeps any example/pos either side has", () => {
  const merged = S.mergeWordbank(
    { bond: { meaning: "채권", stage: "mastered", updatedAt: 200 } },
    { bond: { meaning: "채권", stage: "new", updatedAt: 100, example: "a bond sale", pos: "noun" } }
  );
  assert.equal(merged.bond.stage, "mastered", "the newer stage change wins");
  assert.equal(merged.bond.example, "a bond sale", "but the example is not thrown away");
  assert.equal(merged.bond.pos, "noun");
});

test("a delete beats a stale remote copy instead of being resurrected", () => {
  // The regression from 631d73a, now covering reads AND 오답노트.
  const local = { "a1": { deleted: true, updatedAt: 500 } };
  const remote = { "a1": { readAt: 100, completed: true, updatedAt: 100 } };
  assert.equal(S.mergeReads(local, remote).a1.deleted, true);
  assert.equal(S.mergeErrors(local, remote).a1.deleted, true);
  // ...and a newer remote edit still wins over an older local one.
  assert.equal(S.mergeReads({ a1: { updatedAt: 1 } }, { a1: { updatedAt: 9, completed: true } }).a1.completed, true);
});

test("mergeReads falls back to readAt when updatedAt predates syncing", () => {
  const merged = S.mergeReads({ a1: { readAt: 50 } }, { a1: { readAt: 900, completed: true } });
  assert.equal(merged.a1.completed, true);
});

test("mergeWriting prefers the newer entry, then the one with more work in it", () => {
  const newer = S.mergeWriting(
    { p1: { inputs: ["short"], grades: {}, updatedAt: 20 } },
    { p1: { inputs: ["a much longer answer"], grades: { 0: {} }, updatedAt: 10 } }
  );
  assert.deepEqual(newer.p1.inputs, ["short"], "updatedAt decides when both sides have one");

  // Entries written before syncing existed carry no timestamp at all.
  const untimed = S.mergeWriting(
    { p1: { inputs: [""], grades: {} } },
    { p1: { inputs: ["a real answer"], grades: { 0: {} } } }
  );
  assert.deepEqual(untimed.p1.inputs, ["a real answer"], "never discard work for an empty draft");
});

test("a writing reset tombstone survives the merge", () => {
  const merged = S.mergeWriting(
    { p1: { deleted: true, updatedAt: 500 } },
    { p1: { inputs: ["old answer"], updatedAt: 100 } }
  );
  assert.equal(merged.p1.deleted, true);
});

test("sweepTombstones drops only deletions old enough to have propagated", () => {
  const now = 100 * DAY;
  const swept = S.sweepTombstones({
    old: { deleted: true, updatedAt: now - 31 * DAY },
    recent: { deleted: true, updatedAt: now - 2 * DAY },
    alive: { stage: "new", updatedAt: now },
  }, now);
  assert.deepEqual(Object.keys(swept).sort(), ["alive", "recent"]);
});

test("sweepTombstones returns the same object when nothing changed", () => {
  const map = { a: { stage: "new" } };
  assert.equal(S.sweepTombstones(map, Date.now()), map, "identity is what keeps React from re-rendering");
});

/* ------------------------------------------------------- word lookup -- */

test("candidateForms de-inflects the endings the glossary lookup relies on", () => {
  const has = (w, form) => assert.ok(S.candidateForms(w).includes(form), `${w} -> ${form}`);
  has("companies", "company");
  has("stopped", "stop");
  has("liked", "like");
  has("walked", "walk");
  has("running", "run");
  has("making", "make");
  has("reading", "read");
  has("banks", "bank");
  assert.deepEqual(S.candidateForms("pass"), ["pass"], "-ss is not a plural");
  assert.deepEqual(S.candidateForms("!!!"), []);
});

test("lookupGloss prefers the article glossary, then the wordbank", () => {
  const gloss = { stop: "멈추다", tokenization: { meaning: "토큰화", pos: "noun" } };
  const bank = { yield: { meaning: "수익률", pos: "noun" } };
  assert.equal(S.lookupGloss("stopped", gloss, bank).def, "멈추다");
  assert.equal(S.lookupGloss("stopped", gloss, bank).source, "gloss");
  assert.equal(S.lookupGloss("Tokenization", gloss, bank).pos, "noun", "object entries carry pos");
  assert.equal(S.lookupGloss("yields", gloss, bank).source, "bank");
  assert.equal(S.lookupGloss("yields", gloss, { yield: { meaning: "x", deleted: true } }), null,
    "a soft-deleted word is not a definition");
  assert.equal(S.lookupGloss("unheardof", gloss, bank), null);
});

test("normText makes 오답노트 answer matching forgiving", () => {
  assert.equal(S.normText("  The  Bank's,  rate. "), "the banks rate", "punctuation, apostrophes and runs of space all go");
  assert.equal(S.normText("Yes!"), S.normText("yes"));
});
