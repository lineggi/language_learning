#!/usr/bin/env node
/**
 * build_packs.js — Daybreak Wire pack builder
 *
 * Flow:
 *   1. Scrape CoinDesk's homepage "Most Read" module for the top stories
 *      (title + real article URL). Fall back to the RSS feed if that fails.
 *   2. Ask Gemini to pick the 3 best stories and rewrite each into a B1–B2
 *      English learning "pack". Gemini chooses by candidate NUMBER only — it
 *      never writes URLs, so the original link is always the real one we scraped.
 *   3. Prepend today's 3 packs to packs.json (accumulating feed).
 *
 * Requires Node 18+ (global fetch). Run in GitHub Actions daily.
 *
 * Env:
 *   GEMINI_API_KEY  (required)  — Google AI Studio key
 *   GEMINI_MODEL    (optional)  — defaults to "gemini-2.5-flash"
 */

const fs = require("fs");
const path = require("path");

const API_KEY = process.env.GEMINI_API_KEY;
const MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";
const PACKS_PATH = path.join(__dirname, "packs.json");

const HOMEPAGE = "https://www.coindesk.com/";
const RSS_FEEDS = ["https://www.coindesk.com/arc/outboundfeeds/rss/"];
const UA = "DaybreakWire/1.0 (+github actions)";

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function kstDateString(d = new Date()) {
  const kst = new Date(d.getTime() + 9 * 60 * 60 * 1000);
  return kst.toISOString().slice(0, 10);
}

function stripTags(s) {
  return String(s || "")
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

async function fetchWithRetry(url, opts = {}, tries = 3) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, opts);
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
      return res;
    } catch (err) {
      lastErr = err;
      const wait = 1000 * Math.pow(2, i);
      console.warn(`fetch failed (${i + 1}/${tries}): ${err.message}; retry in ${wait}ms`);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
  throw lastErr;
}

// ---------------------------------------------------------------------------
// Candidate collection: Most Read (preferred) → RSS (fallback)
// ---------------------------------------------------------------------------

// CoinDesk article paths look like /markets/2026/07/02/some-slug or
// /policy/some-long-hyphenated-slug. Section landing pages (/markets/) and
// tag/author pages are rejected.
const SECTION = "(?:markets|business|policy|tech|finance|opinion|web3|learn|layer2|coindesk-indices|consensus-magazine|newsletters|video|podcasts|price)";
const ARTICLE_RE = new RegExp(
  `^https://www\\.coindesk\\.com/${SECTION}/(?:20\\d\\d/\\d{2}/\\d{2}/|)[a-z0-9]+(?:-[a-z0-9]+){2,}/?$`,
  "i"
);

function absUrl(href) {
  if (!href) return null;
  if (href.startsWith("//")) return "https:" + href;
  if (href.startsWith("http")) return href.split(/[?#]/)[0];
  if (href.startsWith("/")) return "https://www.coindesk.com" + href.split(/[?#]/)[0];
  return null;
}

function isArticleUrl(url) {
  return !!url && ARTICLE_RE.test(url);
}

// Pull <a href>…text…</a> pairs out of an HTML fragment.
function extractAnchors(fragment) {
  const out = [];
  const re = /<a\b[^>]*?href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(fragment))) {
    const url = absUrl(m[1]);
    let title = stripTags(m[2]);
    // Fall back to aria-label / title attribute when the anchor wraps an image.
    if (!title) {
      const attr = m[0].match(/(?:aria-label|title)=["']([^"']+)["']/i);
      if (attr) title = stripTags(attr[1]);
    }
    if (url) out.push({ link: url, title });
  }
  return out;
}

function dedupeByUrl(items) {
  const seen = new Set();
  const out = [];
  for (const it of items) {
    if (seen.has(it.link)) continue;
    seen.add(it.link);
    out.push(it);
  }
  return out;
}

// Scrape the homepage "Most Read" / "Most Popular" module.
async function fetchMostRead() {
  const res = await fetchWithRetry(HOMEPAGE, { headers: { "User-Agent": UA } });
  const html = await res.text();

  // 1) Prefer anchors that appear right after a "Most Read"/"Most Popular" label.
  let scoped = [];
  const label = html.search(/most\s*(read|popular)/i);
  if (label >= 0) {
    const window = html.slice(label, label + 8000);
    scoped = extractAnchors(window).filter((a) => isArticleUrl(a.link) && a.title.length >= 15);
  }
  scoped = dedupeByUrl(scoped);

  // 2) Fallback within the homepage: use featured/top article links.
  let featured = [];
  if (scoped.length < 3) {
    featured = dedupeByUrl(
      extractAnchors(html).filter((a) => isArticleUrl(a.link) && a.title.length >= 15)
    );
  }

  const items = (scoped.length >= 3 ? scoped : featured).slice(0, 12);
  const usedMostRead = scoped.length >= 3;
  if (items.length < 3) throw new Error("Homepage yielded too few article links");
  return { items, usedMostRead };
}

// Simple RSS parser used as the final fallback.
function parseRss(xml) {
  const items = [];
  const blocks = xml.match(/<item[\s\S]*?<\/item>/gi) || [];
  for (const b of blocks) {
    const t = b.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    const l = b.match(/<link[^>]*>([\s\S]*?)<\/link>/i);
    const d = b.match(/<description[^>]*>([\s\S]*?)<\/description>/i);
    const link = l ? absUrl(stripTags(l[1])) : null;
    if (t && link) {
      items.push({ title: stripTags(t[1]), link, description: d ? stripTags(d[1]) : "" });
    }
  }
  return items;
}

async function fetchRss() {
  let items = [];
  for (const feed of RSS_FEEDS) {
    try {
      const res = await fetchWithRetry(feed, { headers: { "User-Agent": UA } });
      items.push(...parseRss(await res.text()));
    } catch (err) {
      console.warn(`RSS feed failed ${feed}: ${err.message}`);
    }
  }
  return dedupeByUrl(items).slice(0, 15);
}

async function collectCandidates() {
  try {
    const { items, usedMostRead } = await fetchMostRead();
    console.log(`Homepage scrape: ${items.length} candidates (${usedMostRead ? "Most Read" : "featured"}).`);
    return { candidates: items, label: usedMostRead ? "Most Read" : "Top Story", ranked: usedMostRead };
  } catch (err) {
    console.warn(`Most Read scrape failed (${err.message}); falling back to RSS.`);
    const rss = await fetchRss();
    console.log(`RSS fallback: ${rss.length} candidates.`);
    return { candidates: rss, label: "Editor's Pick", ranked: false };
  }
}

// ---------------------------------------------------------------------------
// Gemini
// ---------------------------------------------------------------------------

const PACK_SCHEMA = {
  type: "object",
  properties: {
    packs: {
      type: "array",
      items: {
        type: "object",
        properties: {
          sourceIndex: { type: "integer" }, // 1-based index into the candidate list
          rank: { type: "integer" },
          hook: { type: "string" },
          title: { type: "string" },
          passage: { type: "string" },
          // A structured-output object needs declared properties; a free-form
          // map returns empty. Use an array of {word, meaning} and convert later.
          glossary: {
            type: "array",
            items: {
              type: "object",
              properties: {
                word: { type: "string" },
                meaning: { type: "string" },
              },
              required: ["word", "meaning"],
            },
          },
          questions: { type: "array", items: { type: "string" } },
          modelAnswers: { type: "array", items: { type: "string" } },
        },
        required: [
          "sourceIndex",
          "rank",
          "hook",
          "title",
          "passage",
          "glossary",
          "questions",
          "modelAnswers",
        ],
      },
    },
  },
  required: ["packs"],
};

function buildPrompt(candidates, label, ranked) {
  const list = candidates
    .map((c, i) => `${i + 1}. TITLE: ${c.title}\n   URL: ${c.link}${c.description ? `\n   SUMMARY: ${c.description.slice(0, 300)}` : ""}`)
    .join("\n\n");

  const order = ranked
    ? "These candidates are already ordered by popularity (the \"Most Read\" list), so prefer the ones near the top unless a lower story is far more relevant to the learner."
    : "Pick the 3 most relevant and interesting stories for the learner.";

  return `You are the editor of "Daybreak Wire", a daily crypto news reader that helps a Korean intermediate (B1–B2) English learner. The learner is a crypto/fintech PM interested in stablecoins, regulation, tokenization, and exchanges like OKX.

CANDIDATE STORIES (${label}):
${list}

${order}

Choose exactly 3 stories. For EACH chosen story produce an object with:
- sourceIndex: the NUMBER of the chosen candidate above (1-based). Do NOT invent URLs — I attach the real link myself using this number.
- rank: 1, 2, or 3 (1 = most recommended).
- hook: ONE short sentence in KOREAN explaining why this story is worth reading today.
- title: a short English headline (max ~10 words). Rewrite it; do not copy verbatim.
- passage: 110–140 words of ORIGINAL B1–B2 English that you write yourself, explaining the story clearly. DO NOT copy sentences from the source. Keep sentences short.
- glossary: a list of ~20–24 objects, each { "word": <a SINGLE lowercase word (one token, no spaces or phrases) that appears in YOUR passage>, "meaning": <a short, simple English definition a beginner can understand — about 2 to 6 words, roughly under 40 characters, ENGLISH ONLY (never Korean), fitting the passage context> }. Choose single words a B1–B2 learner might not know. Do not use hard words inside the definition.
- questions: exactly 3 English writing prompts — Q1 a fact-check question, Q2 a context-vocabulary question, Q3 an opinion question (2–3 sentences).
- modelAnswers: exactly 3 short model answers, one per question.

Return JSON matching the schema: { "packs": [ {...}, {...}, {...} ] }. Output ONLY JSON.`;
}

async function callGemini(prompt) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${API_KEY}`;
  const body = {
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    generationConfig: {
      temperature: 0.7,
      responseMimeType: "application/json",
      responseSchema: PACK_SCHEMA,
    },
  };
  const res = await fetchWithRetry(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  const text = data?.candidates?.[0]?.content?.parts?.map((p) => p.text).join("") || "";
  try {
    return JSON.parse(text);
  } catch (err) {
    console.error("Failed to parse Gemini JSON. First 400 chars:\n", text.slice(0, 400));
    throw err;
  }
}

// ---------------------------------------------------------------------------
// packs.json I/O
// ---------------------------------------------------------------------------

function loadPacks() {
  if (!fs.existsSync(PACKS_PATH)) return [];
  try {
    const raw = fs.readFileSync(PACKS_PATH, "utf8").trim();
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch (err) {
    console.warn("packs.json unreadable, starting fresh:", err.message);
    return [];
  }
}

// Trim a meaning to a soft length WITHOUT cutting a word in half. Only trims
// runaway meanings; short ones pass through untouched.
function tidyMeaning(s) {
  let v = String(s || "").trim().replace(/\s+/g, " ");
  const CAP = 48;
  if (v.length > CAP) {
    const cut = v.slice(0, CAP);
    const sp = cut.lastIndexOf(" ");
    v = (sp > 20 ? cut.slice(0, sp) : cut).replace(/[,;:\-]+$/, "").trim();
  }
  return v;
}

// Accepts either the array form [{word, meaning}] (from the schema) or a plain
// {word: meaning} object, and returns a lowercase-keyed map the app expects.
// Only SINGLE words are kept — the app collects one token per click, so
// multi-word phrases in the glossary could never be surfaced.
function normalizeGlossary(g) {
  const out = {};
  const add = (word, meaning) => {
    const key = String(word || "").toLowerCase().trim();
    const val = tidyMeaning(meaning);
    if (key && val && !/\s/.test(key)) out[key] = val;
  };
  if (Array.isArray(g)) {
    g.forEach((item) => item && add(item.word, item.meaning));
  } else if (g && typeof g === "object") {
    for (const [k, v] of Object.entries(g)) add(k, v);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  if (!API_KEY) {
    console.error("GEMINI_API_KEY is not set.");
    process.exit(1);
  }

  const date = kstDateString();
  console.log(`Building packs for ${date} using model ${MODEL}`);

  const { candidates, label, ranked } = await collectCandidates();
  if (candidates.length < 3) {
    console.error("Fewer than 3 candidates collected; aborting without changes.");
    process.exit(1);
  }

  const result = await callGemini(buildPrompt(candidates, label, ranked));
  const rawPacks = Array.isArray(result?.packs) ? result.packs : [];
  if (rawPacks.length === 0) {
    console.error("Gemini returned no packs; aborting without changes.");
    process.exit(1);
  }

  const newPacks = rawPacks.slice(0, 3).map((p, i) => {
    const rank = Number.isInteger(p.rank) ? p.rank : i + 1;
    // Map Gemini's chosen candidate number to the real scraped URL. This is the
    // key correctness guarantee: the "원문" link is never invented by the model.
    const idx = Number.isInteger(p.sourceIndex) ? p.sourceIndex - 1 : i;
    const src = candidates[idx] || candidates[i] || candidates[0];
    return {
      id: `cd-${date}-${rank}`,
      date,
      rank,
      reads: `${label} #${rank}`,
      hook: p.hook || "",
      url: src.link || "",
      title: p.title || src.title || "",
      source: "Daybreak Wire (based on CoinDesk)",
      passage: p.passage || "",
      glossary: normalizeGlossary(p.glossary),
      questions: Array.isArray(p.questions) ? p.questions.slice(0, 3) : [],
      modelAnswers: Array.isArray(p.modelAnswers) ? p.modelAnswers.slice(0, 3) : [],
    };
  });

  // Guard: every pack must carry a real CoinDesk URL.
  const missing = newPacks.filter((p) => !p.url);
  if (missing.length) console.warn(`${missing.length} pack(s) have no URL after mapping.`);

  // Replace any existing packs that share an id (same day + rank) with the
  // freshly generated ones, so a re-run updates today's packs instead of being
  // silently dropped. Older days are preserved in the accumulating feed.
  const existing = loadPacks();
  const newIds = new Set(newPacks.map((p) => p.id));
  const merged = [...newPacks, ...existing.filter((p) => !newIds.has(p.id))];

  fs.writeFileSync(PACKS_PATH, JSON.stringify(merged, null, 2) + "\n", "utf8");
  console.log(`Wrote ${newPacks.length} new packs (${label}; total ${merged.length}) to packs.json`);
  newPacks.forEach((p) => console.log(`  #${p.rank} ${p.title} -> ${p.url}`));
}

main().catch((err) => {
  console.error("build_packs failed:", err);
  process.exit(1);
});
