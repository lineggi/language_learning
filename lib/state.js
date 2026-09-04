/*
 * lib/state.js — Daybreak Wire pure state logic.
 *
 * Everything here is a pure function of its arguments: no DOM, no React, no
 * localStorage, no network. That is the point — these are the rules that kept
 * breaking (streak decay, wordbank stage transitions, cross-device merges), and
 * keeping them here means `npm test` can exercise them directly in Node while
 * index.html uses the exact same code in the browser.
 *
 * Loaded two ways:
 *   · browser — <script src="lib/state.js"> before the app, exposes window.DBW
 *   · node     — require("./lib/state.js") from the test suite
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.DBW = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  /* ---------------------------------------------------------------- */
  /* Dates (the app's day boundary is KST, not the device's timezone)  */
  /* ---------------------------------------------------------------- */

  // "YYYY-MM-DD" for right now in KST. `now` is injectable so tests can pin it.
  function kstToday(now) {
    const t = now == null ? Date.now() : (now instanceof Date ? now.getTime() : now);
    return new Date(t + 9 * 3600 * 1000).toISOString().slice(0, 10);
  }
  function daysBetween(a, b) {
    const da = new Date(a + "T00:00:00Z").getTime();
    const db = new Date(b + "T00:00:00Z").getTime();
    return Math.round((db - da) / 86400000);
  }
  // Calendar cells for the streak modal: "YYYY-MM" in, list of "YYYY-MM-DD"
  // (with leading nulls for the blank cells before the 1st) out.
  function monthDays(ym) {
    const [y, m] = ym.split("-").map(Number);
    const startDow = new Date(Date.UTC(y, m - 1, 1)).getUTCDay();
    const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
    const cells = new Array(startDow).fill(null);
    for (let d = 1; d <= daysInMonth; d++) cells.push(`${ym}-${String(d).padStart(2, "0")}`);
    return cells;
  }
  function shiftMonth(ym, delta) {
    const [y, m] = ym.split("-").map(Number);
    const d = new Date(Date.UTC(y, m - 1 + delta, 1));
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
  }

  /* ---------------------------------------------------------------- */
  /* Spaced repetition                                                 */
  /* ---------------------------------------------------------------- */

  const REVIEW_DUE_DAYS = 3; // 복습중 → due for 복습하기 (and stays due until reviewed)

  // Stage of a word, with the legacy `learned` boolean migrated on read.
  function stageOf(v) { return (v && v.stage) || (v && v.learned ? "review" : "new"); }

  // A 복습중 word is due once REVIEW_DUE_DAYS have passed. There is no upper
  // bound on purpose: an overdue word simply stays due instead of decaying
  // back to 미암기 and making the user re-learn what they already knew.
  function reviewDue(v, today) {
    return stageOf(v) === "review" && !!v.reviewSince
      && daysBetween(v.reviewSince, today || kstToday()) >= REVIEW_DUE_DAYS;
  }

  // Classify a word about to be collected: "new" (absent or soft-deleted →
  // added), "exists" (already 미암기/복습중 → left alone, never duplicated),
  // "mastered" (already 완료 → seeing it again means it wasn't remembered,
  // so it goes back to 미암기).
  function classifyWord(wordbank, base) {
    const norm = String(base || "").toLowerCase().trim();
    const cur = wordbank && wordbank[norm];
    if (!cur || cur.deleted) return "new";
    return stageOf(cur) === "mastered" ? "mastered" : "exists";
  }

  /* ---------------------------------------------------------------- */
  /* Streak                                                            */
  /* ---------------------------------------------------------------- */

  // A streak is broken once more than one day has passed since lastDate with
  // no word learned — normalize to 0 so a stale copy never reads as active.
  // `days` (every date a word was ever learned) is a history log and is never
  // reset; lastDate is backfilled into it for records saved before it existed.
  function normalizeStreak(s, today) {
    const v = s || { count: 0, lastDate: null, days: [] };
    const days = v.lastDate && !(v.days || []).includes(v.lastDate)
      ? [...(v.days || []), v.lastDate]
      : (v.days || []);
    if (!v.lastDate || !v.count) return { ...v, days };
    return daysBetween(v.lastDate, today || kstToday()) > 1
      ? { count: 0, lastDate: v.lastDate, days }
      : { ...v, days };
  }

  // Both sides are normalized against TODAY before comparing, so a correctly
  // decayed local streak can't lose to a stale remote copy still holding the
  // old higher count. `days` is unioned regardless of which side wins.
  function pickStreak(local, remote, today) {
    const l = normalizeStreak(local, today), r = normalizeStreak(remote, today);
    const days = Array.from(new Set([...(l.days || []), ...(r.days || [])])).sort();
    const winner = (l.count || 0) !== (r.count || 0)
      ? ((l.count || 0) > (r.count || 0) ? l : r)
      : ((l.lastDate || "") >= (r.lastDate || "") ? l : r); // tie → more recent lastDate
    return { ...winner, days };
  }

  // Advance the day-streak for "a word was memorized today". Idempotent within
  // a day: called again the same day it only keeps `days` in sync.
  function bumpStreak(prev, today) {
    const day = today || kstToday();
    const p = prev || { count: 0, lastDate: null, days: [] };
    const days = (p.days || []).includes(day) ? (p.days || []) : [...(p.days || []), day];
    if (p.lastDate === day) return { ...p, days };
    if (p.lastDate && daysBetween(p.lastDate, day) === 1)
      return { count: (p.count || 0) + 1, lastDate: day, days };
    return { count: 1, lastDate: day, days };
  }

  /* ---------------------------------------------------------------- */
  /* Cross-device merges (last-write-wins on updatedAt)                */
  /* ---------------------------------------------------------------- */

  // Words: keys normalized to lowercase so the same word never survives twice
  // under different casing; per-word last-write-wins by updatedAt so devices
  // converge on the most recent stage change; example/pos kept if either has one.
  function mergeWordbank(local, remote) {
    const out = {};
    const put = (k, v) => {
      const key = String(k || "").toLowerCase().trim();
      if (!key || !v) return;
      const cur = out[key];
      if (!cur) { out[key] = v; return; }
      const win = (v.updatedAt || 0) > (cur.updatedAt || 0) ? v : cur;
      out[key] = {
        ...win,
        example: cur.example || v.example || win.example || "",
        pos: cur.pos || v.pos || win.pos || null,
      };
    };
    for (const [k, v] of Object.entries(remote || {})) put(k, v); // remote first
    for (const [k, v] of Object.entries(local || {})) put(k, v);  // then local
    return out;
  }

  // Generic per-key last-write-wins merge, used for everything whose entries
  // carry an updatedAt. A soft delete is just a write with a fresh timestamp,
  // so it wins over a stale remote copy instead of being resurrected by it.
  function mergeByUpdatedAt(local, remote, stamp) {
    const at = stamp || ((x) => (x && (x.updatedAt || x.readAt)) || 0);
    const out = {};
    const put = (k, v) => {
      if (!k || !v) return;
      const cur = out[k];
      out[k] = !cur || at(v) > at(cur) ? v : cur;
    };
    for (const [k, v] of Object.entries(remote || {})) put(k, v);
    for (const [k, v] of Object.entries(local || {})) put(k, v);
    return out;
  }

  const mergeReads = (local, remote) => mergeByUpdatedAt(local, remote);
  // 오답노트 entries carry an updatedAt bumped on every stage change, so the
  // same rule gives the newest review state across devices.
  const mergeErrors = (local, remote) => mergeByUpdatedAt(local, remote);

  // Writing answers are keyed by pack id and rewritten wholesale on each edit.
  // Entries saved before syncing existed have no updatedAt at all, so fall back
  // to "the side with more work in it" rather than silently preferring an empty
  // draft that happens to be stamped.
  function mergeWriting(local, remote) {
    const weight = (v) => {
      if (!v) return -1;
      const inputs = (v.inputs || []).reduce((n, s) => n + String(s || "").trim().length, 0);
      return inputs + Object.keys(v.grades || {}).length * 50 + (v.overall ? 100 : 0);
    };
    const out = {};
    const put = (k, v) => {
      if (!k || !v) return;
      const cur = out[k];
      if (!cur) { out[k] = v; return; }
      const a = v.updatedAt || 0, b = cur.updatedAt || 0;
      if (a !== b) { out[k] = a > b ? v : cur; return; }
      out[k] = weight(v) > weight(cur) ? v : cur;
    };
    for (const [k, v] of Object.entries(remote || {})) put(k, v);
    for (const [k, v] of Object.entries(local || {})) put(k, v);
    return out;
  }

  // Permanently drop soft-deleted entries whose tombstone is old enough to
  // have propagated everywhere — deletion has already won any merge by then,
  // so keeping it forever would just grow the synced blob.
  const TOMBSTONE_TTL_MS = 30 * 86400000;
  function sweepTombstones(map, now, ttl) {
    const cutoff = (now == null ? Date.now() : now) - (ttl == null ? TOMBSTONE_TTL_MS : ttl);
    const next = {};
    let changed = false;
    for (const [k, v] of Object.entries(map || {})) {
      if (v && v.deleted && (v.updatedAt || 0) <= cutoff) { changed = true; continue; }
      next[k] = v;
    }
    return changed ? next : map;
  }

  /* ---------------------------------------------------------------- */
  /* Word forms / glossary lookup                                      */
  /* ---------------------------------------------------------------- */

  // Cheap English de-inflection: enough forms to find "stopped" under "stop"
  // in a per-article glossary without shipping a real lemmatizer.
  function candidateForms(raw) {
    const w = String(raw || "").toLowerCase().replace(/[^a-z\-']/g, "");
    if (!w) return [];
    const forms = new Set([w]);
    // plurals / 3rd person
    if (w.endsWith("ies") && w.length > 4) forms.add(w.slice(0, -3) + "y");
    if (w.endsWith("es") && w.length > 3) { forms.add(w.slice(0, -2)); forms.add(w.slice(0, -1)); }
    if (w.endsWith("s") && !w.endsWith("ss") && w.length > 3) forms.add(w.slice(0, -1));
    // past tense
    if (w.endsWith("ied") && w.length > 4) forms.add(w.slice(0, -3) + "y");
    if (w.endsWith("ed") && w.length > 3) {
      forms.add(w.slice(0, -2));            // walked -> walk
      forms.add(w.slice(0, -1));            // liked -> like
      if (w[w.length - 3] === w[w.length - 4]) forms.add(w.slice(0, -3)); // stopped -> stop
    }
    // -ing
    if (w.endsWith("ing") && w.length > 4) {
      forms.add(w.slice(0, -3));            // reading -> read
      forms.add(w.slice(0, -3) + "e");      // making -> make
      if (w[w.length - 4] === w[w.length - 5]) forms.add(w.slice(0, -4)); // running -> run
    }
    return Array.from(forms);
  }

  // A glossary entry is either a plain string (legacy packs, no pos) or
  // { meaning, pos } (current packs) — normalize both to the same shape.
  function glossVal(v) {
    if (v == null) return null;
    return typeof v === "string" ? { meaning: v, pos: null } : { meaning: v.meaning || "", pos: v.pos || null };
  }
  function lookupGloss(word, glossary, wordbank) {
    const forms = candidateForms(word);
    for (const f of forms) {
      if (glossary && glossary[f]) {
        const gv = glossVal(glossary[f]);
        return { base: f, def: gv.meaning, pos: gv.pos, source: "gloss" };
      }
    }
    for (const f of forms) {
      if (wordbank && wordbank[f] && !wordbank[f].deleted)
        return { base: f, def: wordbank[f].meaning, pos: wordbank[f].pos || null, source: "bank" };
    }
    // last resort: whole phrase key present verbatim
    const lc = String(word || "").toLowerCase();
    if (glossary && glossary[lc]) {
      const gv = glossVal(glossary[lc]);
      return { base: lc, def: gv.meaning, pos: gv.pos, source: "gloss" };
    }
    return null;
  }

  function normText(s) {
    return String(s || "").toLowerCase().trim().replace(/\s+/g, " ").replace(/[.,!?;:'"()]/g, "");
  }

  const POS_KO = {
    noun: "명사", verb: "동사", adjective: "형용사", adverb: "부사",
    preposition: "전치사", conjunction: "접속사", pronoun: "대명사",
    determiner: "한정사", interjection: "감탄사", phrase: "구",
  };

  return {
    kstToday, daysBetween, monthDays, shiftMonth,
    REVIEW_DUE_DAYS, stageOf, reviewDue, classifyWord,
    normalizeStreak, pickStreak, bumpStreak,
    mergeWordbank, mergeByUpdatedAt, mergeReads, mergeErrors, mergeWriting,
    TOMBSTONE_TTL_MS, sweepTombstones,
    candidateForms, glossVal, lookupGloss, normText, POS_KO,
  };
});
