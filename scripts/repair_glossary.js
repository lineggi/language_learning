#!/usr/bin/env node
/*
 * scripts/repair_glossary.js — rewrite definitions that give away their word.
 *
 * The flashcard shows the meaning and asks the learner to recall the word, so
 * "Existing in or as part of a tradition" for `traditional` is unanswerable as
 * intended. build_packs.js now catches this for each new day; this does the
 * same pass over everything already published, which cannot be regenerated.
 *
 * Reads packs.json and every archive shard, rewrites what leaks, and re-shards.
 * A rewrite that still leaks is thrown away and the original kept, so a bad
 * batch can only leave things as they were.
 *
 *   node scripts/repair_glossary.js --dry-run   list what would change
 *   node scripts/repair_glossary.js             rewrite and save
 *
 * Needs GEMINI_API_KEY unless --dry-run.
 */
const fs = require("fs");
const path = require("path");
const B = require("../build_packs.js");
const { leaksHeadword, maskWord } = require("../lib/state.js");

const ROOT = path.join(__dirname, "..");
const ARCHIVE = path.join(ROOT, "archive");
const DRY = process.argv.includes("--dry-run");

function loadAll() {
  const packs = JSON.parse(fs.readFileSync(path.join(ROOT, "packs.json"), "utf8"));
  if (fs.existsSync(ARCHIVE)) {
    for (const f of fs.readdirSync(ARCHIVE).filter((f) => /^\d{4}-\d{2}\.json$/.test(f)).sort()) {
      packs.push(...JSON.parse(fs.readFileSync(path.join(ARCHIVE, f), "utf8")));
    }
  }
  return B.dedupeById(packs);
}

(async () => {
  const packs = loadAll();
  const leaks = B.findLeaks(packs);
  const entries = packs.reduce((n, p) => n + Object.keys(p.glossary || {}).length, 0);

  console.log(`${packs.length} packs · ${entries.toLocaleString()} glossary entries`);
  console.log(`${leaks.length} definition(s) contain their own word (${(leaks.length / entries * 100).toFixed(1)}%)\n`);
  if (!leaks.length) { console.log("Nothing to repair."); return; }

  for (const l of leaks.slice(0, DRY ? leaks.length : 8)) {
    console.log(`  [${l.word}] ${maskWord(l.meaning, l.word)}`);
  }
  if (!DRY && leaks.length > 8) console.log(`  … and ${leaks.length - 8} more`);

  if (DRY) { console.log("\n--dry-run: nothing written."); return; }
  if (!process.env.GEMINI_API_KEY) { console.error("\nGEMINI_API_KEY is not set."); process.exit(1); }

  console.log("");
  const fixes = await B.rewriteLeaks(leaks);
  const fixed = B.applyFixes(packs, fixes);
  const left = B.findLeaks(packs).length;

  if (!fixed) { console.log("Nothing could be rewritten; files untouched."); return; }
  B.writeFeed(packs);
  console.log(`\nRewrote ${fixed} of ${leaks.length}. ${left} still leak (kept their original).`);
})().catch((e) => { console.error(e); process.exit(1); });
