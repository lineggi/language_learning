#!/usr/bin/env node
/*
 * scripts/check_feed.js — integrity check for the on-disk feed.
 *
 * The unit tests cover the sharding rules; this checks the actual committed
 * data obeys them, so a bad build can never ship an archive the app can't
 * resolve (a 보관함 row pointing at a shard that doesn't contain it would be a
 * dead link the user only discovers by tapping it).
 *
 * Exits non-zero with a list of problems. Run: node scripts/check_feed.js
 */
const fs = require("fs");
const path = require("path");
const { splitPacks } = require("../build_packs.js");

const ROOT = path.join(__dirname, "..");
const ARCHIVE = path.join(ROOT, "archive");
const problems = [];
const read = (f) => JSON.parse(fs.readFileSync(f, "utf8"));

const packs = read(path.join(ROOT, "packs.json"));
if (!Array.isArray(packs) || !packs.length) problems.push("packs.json is empty or not an array");

const indexPath = path.join(ARCHIVE, "index.json");
const index = fs.existsSync(indexPath) ? read(indexPath) : [];
const shardFiles = fs.existsSync(ARCHIVE)
  ? fs.readdirSync(ARCHIVE).filter((f) => /^\d{4}-\d{2}\.json$/.test(f)).sort()
  : [];
const shards = Object.fromEntries(shardFiles.map((f) => [f.replace(/\.json$/, ""), read(path.join(ARCHIVE, f))]));

// Every pack, wherever it lives, must be complete enough for the reader.
const REQUIRED = ["id", "date", "title", "passage", "glossary", "questions"];
const all = [...packs, ...Object.values(shards).flat()];
const seen = new Map();
for (const p of all) {
  for (const k of REQUIRED) if (p[k] == null) problems.push(`${p.id || "(no id)"}: missing ${k}`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(p.date || "")) problems.push(`${p.id}: bad date ${p.date}`);
  if (seen.has(p.id)) problems.push(`${p.id}: duplicated (also in ${seen.get(p.id)})`);
  seen.set(p.id, "feed");
}

// A pack must live in the shard its date names, or the app fetches the wrong file.
for (const [ym, list] of Object.entries(shards)) {
  for (const p of list) if (!String(p.date).startsWith(ym)) problems.push(`${p.id} (${p.date}) is in shard ${ym}`);
}

// The index is what 보관함 lists; every row must resolve to a real pack.
const indexIds = new Set(index.map((e) => e.id));
for (const e of index) if (!seen.has(e.id)) problems.push(`index row ${e.id} resolves to no pack`);
for (const id of seen.keys()) if (index.length && !indexIds.has(id)) problems.push(`${id} is missing from the index`);
if (index.length !== indexIds.size) problems.push("the index has duplicate rows");

// packs.json must be exactly what the current split rules produce, so a hand
// edit or an interrupted build can't leave the recent window out of step.
const expected = splitPacks(all);
const got = packs.map((p) => p.id).join(",");
const want = expected.recent.map((p) => p.id).join(",");
if (got !== want) problems.push(`packs.json is not the current recent window (${packs.length} packs vs ${expected.recent.length} expected)`);

const kb = (f) => Math.round(fs.statSync(f).size / 1024);
if (problems.length) {
  console.error(`Feed check FAILED (${problems.length}):`);
  for (const p of problems.slice(0, 40)) console.error("  · " + p);
  process.exit(1);
}
console.log(
  `Feed OK — packs.json ${packs.length} packs / ${kb(path.join(ROOT, "packs.json"))}KB, ` +
  `index ${index.length} rows / ${kb(indexPath)}KB, ` +
  `${shardFiles.length} shard(s): ${shardFiles.join(", ") || "none"}`
);
