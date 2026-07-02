#!/usr/bin/env node
/**
 * build_packs.js — Daybreak Wire pack builder
 *
 * Flow:
 *   1. Fetch CoinDesk RSS feed(s).
 *   2. Ask Gemini to pick the 3 most relevant crypto stories and rewrite each
 *      into a B1–B2 English learning "pack" (passage + glossary + questions).
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

// CoinDesk RSS feeds. The main feed is enough; extras add topical breadth.
const RSS_FEEDS = [
  "https://www.coindesk.com/arc/outboundfeeds/rss/",
];

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function kstDateString(d = new Date()) {
  // Convert to KST (UTC+9) and format YYYY-MM-DD.
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
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function extractTag(block, tag) {
  const m = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "i"));
  return m ? stripTags(m[1]) : "";
}

// Very small RSS parser — good enough for CoinDesk's feed.
function parseRss(xml) {
  const items = [];
  const itemBlocks = xml.match(/<item[\s\S]*?<\/item>/gi) || [];
  for (const block of itemBlocks) {
    const title = extractTag(block, "title");
    const link = extractTag(block, "link");
    const pubDate = extractTag(block, "pubDate");
    const description =
      extractTag(block, "description") || extractTag(block, "content:encoded");
    if (title && link) {
      items.push({ title, link, pubDate, description });
    }
  }
  return items;
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
          rank: { type: "integer" },
          reads: { type: "string" },
          hook: { type: "string" },
          url: { type: "string" },
          title: { type: "string" },
          passage: { type: "string" },
          glossary: {
            type: "object",
            // free-form keys; Gemini fills word -> short meaning
          },
          questions: { type: "array", items: { type: "string" } },
          modelAnswers: { type: "array", items: { type: "string" } },
        },
        required: [
          "rank",
          "hook",
          "url",
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

function buildPrompt(candidates) {
  const list = candidates
    .map(
      (c, i) =>
        `${i + 1}. TITLE: ${c.title}\n   URL: ${c.link}\n   SUMMARY: ${c.description.slice(0, 400)}`
    )
    .join("\n\n");

  return `You are the editor of "Daybreak Wire", a daily crypto news reader that helps a Korean intermediate (B1–B2) English learner. The learner is a crypto/fintech PM interested in stablecoins, regulation, tokenization, and exchanges like OKX.

From the CoinDesk stories below, pick the 3 most relevant and interesting stories for this learner and turn each into a learning "pack".

CANDIDATE STORIES:
${list}

For EACH of the 3 chosen stories produce an object with these fields:
- rank: 1, 2, or 3 (1 = most recommended).
- reads: a short badge like "Most Read #1".
- hook: ONE short sentence in KOREAN explaining why this story is worth reading today.
- url: the original CoinDesk URL (copy exactly from the candidate).
- title: a short English headline (max ~10 words). Rewrite it; do not copy verbatim.
- passage: 110–140 words of ORIGINAL B1–B2 English that you write yourself, explaining the story clearly. DO NOT copy sentences from the source. Keep sentences short and clear.
- glossary: an object mapping ~20–24 lowercase words that appear in YOUR passage to a short English meaning (max 30 characters) that fits the passage context. Choose words a B1–B2 learner might not know.
- questions: exactly 3 English writing prompts — Q1 a fact-check question about the passage, Q2 a context-vocabulary question, Q3 an opinion question asking for 2–3 sentences.
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
  const text =
    data?.candidates?.[0]?.content?.parts?.map((p) => p.text).join("") || "";

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

function normalizeGlossary(g) {
  const out = {};
  if (g && typeof g === "object") {
    for (const [k, v] of Object.entries(g)) {
      const key = String(k).toLowerCase().trim();
      const val = String(v).trim().slice(0, 30);
      if (key) out[key] = val;
    }
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

  // 1. Collect RSS candidates.
  let candidates = [];
  for (const feed of RSS_FEEDS) {
    try {
      const res = await fetchWithRetry(feed, {
        headers: { "User-Agent": "DaybreakWire/1.0 (+github actions)" },
      });
      const xml = await res.text();
      candidates.push(...parseRss(xml));
    } catch (err) {
      console.warn(`Feed failed ${feed}: ${err.message}`);
    }
  }

  if (candidates.length === 0) {
    console.error("No RSS candidates fetched; aborting without changes.");
    process.exit(1);
  }

  // Keep the freshest ~15 unique-by-title candidates.
  const seen = new Set();
  candidates = candidates.filter((c) => {
    const key = c.title.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 15);

  console.log(`Fetched ${candidates.length} candidate stories.`);

  // 2. Ask Gemini for 3 packs.
  const result = await callGemini(buildPrompt(candidates));
  const rawPacks = Array.isArray(result?.packs) ? result.packs : [];
  if (rawPacks.length === 0) {
    console.error("Gemini returned no packs; aborting without changes.");
    process.exit(1);
  }

  // 3. Normalize and stamp ids/dates.
  const newPacks = rawPacks.slice(0, 3).map((p, i) => {
    const rank = Number.isInteger(p.rank) ? p.rank : i + 1;
    return {
      id: `cd-${date}-${rank}`,
      date,
      rank,
      reads: p.reads || `Most Read #${rank}`,
      hook: p.hook || "",
      url: p.url || "",
      title: p.title || "",
      source: "Daybreak Wire (based on CoinDesk)",
      passage: p.passage || "",
      glossary: normalizeGlossary(p.glossary),
      questions: Array.isArray(p.questions) ? p.questions.slice(0, 3) : [],
      modelAnswers: Array.isArray(p.modelAnswers) ? p.modelAnswers.slice(0, 3) : [],
    };
  });

  // 4. Prepend to packs.json (avoid duplicate ids for the same day/rank).
  const existing = loadPacks();
  const existingIds = new Set(existing.map((p) => p.id));
  const merged = [...newPacks.filter((p) => !existingIds.has(p.id)), ...existing];

  fs.writeFileSync(PACKS_PATH, JSON.stringify(merged, null, 2) + "\n", "utf8");
  console.log(`Wrote ${newPacks.length} new packs (total ${merged.length}) to packs.json`);
}

main().catch((err) => {
  console.error("build_packs failed:", err);
  process.exit(1);
});
