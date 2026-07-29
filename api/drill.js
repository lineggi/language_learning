// Vercel serverless function: quick grammar fill-in-the-blank drills built from
// the day's article, focused on the things Korean learners drop — verb form,
// articles (a/an/the), plurals, prepositions. Same-origin: POST /api/drill.

const DRILL_SCHEMA = {
  type: "object",
  properties: {
    items: {
      type: "array",
      items: {
        type: "object",
        properties: {
          sentence: { type: "string" }, // contains one blank marked as ___
          answer: { type: "string" },   // the missing word
          hint: { type: "string" },     // short Korean grammar hint
        },
        required: ["sentence", "answer", "hint"],
      },
    },
  },
  required: ["items"],
};

function buildPrompt(passage) {
  return `You are an English grammar coach for a Korean upper-intermediate learner.
From the passage below, create 6 short fill-in-the-blank drills that target the grammar
points Korean learners most often get wrong: VERB form/tense/subject agreement, ARTICLES
(a/an/the), PLURALS, and PREPOSITIONS.

PASSAGE:
${passage || "(none)"}

Rules:
- Each drill is ONE short English sentence (max ~14 words), adapted from or inspired by the passage.
- Put exactly ONE blank, written literally as "___", where the target word goes.
- The blank must test a verb form, an article, a plural, or a preposition — NOT content vocabulary.
- "answer" is the single missing word only.
- CRITICAL: the word(s) immediately before or after "___" must NOT share the same root as
  "answer" — e.g. never write "Many business ___" with answer "businesses" (that duplicates
  "business"). If the sentence already contains the word right next to the blank, rewrite the
  sentence so the blank is the ONLY occurrence of that word/stem.
- "hint" is a SHORT Korean hint about the grammar point (e.g. "동사: 3인칭 단수 현재", "관사: 처음 언급", "복수형", "전치사").
- Vary the point types across the 6 items.

Return JSON: { "items": [ { "sentence": "This ___ flexibility.", "answer": "offers", "hint": "동사: 3인칭 단수 현재" } ] }`;
}

// Two words are "the same root" if one is a prefix of the other (catches
// business/businesses, offer/offers, sign/signed) — a plain suffix-stripper
// misses cases like business→busines vs businesses→business, which don't
// converge to the same stem. Short words require an exact match to avoid
// false positives (e.g. "is" being a prefix of "island").
function sameRoot(a, b) {
  const x = String(a || "").toLowerCase().replace(/[^a-z]/g, "");
  const y = String(b || "").toLowerCase().replace(/[^a-z]/g, "");
  if (!x || !y) return false;
  if (Math.min(x.length, y.length) < 4) return x === y;
  return x === y || x.startsWith(y) || y.startsWith(x);
}
// Reject a drill if the word touching the blank shares a root with the answer
// (e.g. "Many business ___" / answer "businesses" duplicates "business").
function blankIsClean(sentence, answer) {
  const before = sentence.split("___")[0].trim().split(/\s+/).pop() || "";
  const after = (sentence.split("___")[1] || "").trim().split(/\s+/)[0] || "";
  return !sameRoot(before, answer) && !sameRoot(after, answer);
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") { res.status(405).json({ error: "Use POST" }); return; }

  const key = (process.env.GEMINI_API_KEY || "").trim();
  if (!key) { res.status(500).json({ error: "GEMINI_API_KEY is not configured on the server." }); return; }
  const model = (process.env.GEMINI_MODEL || "gemini-2.5-flash").trim();

  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch { body = {}; } }
  const passage = (body && body.passage ? String(body.passage) : "").slice(0, 2500);
  if (!passage) { res.status(400).json({ error: "No passage." }); return; }

  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`;
    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: buildPrompt(passage) }] }],
        generationConfig: { temperature: 0.5, responseMimeType: "application/json", responseSchema: DRILL_SCHEMA },
      }),
    });
    if (!r.ok) { const t = await r.text(); res.status(502).json({ error: `Gemini ${r.status}`, detail: t.slice(0, 300) }); return; }
    const data = await r.json();
    const text = data?.candidates?.[0]?.content?.parts?.map((p) => p.text).join("") || "{}";
    let out; try { out = JSON.parse(text); } catch { res.status(502).json({ error: "Could not parse model output", raw: text.slice(0, 300) }); return; }
    const items = (Array.isArray(out.items) ? out.items : [])
      .map((it) => ({
        sentence: String((it && it.sentence) || "").trim(),
        answer: String((it && it.answer) || "").trim(),
        hint: String((it && it.hint) || "").trim(),
      }))
      .filter((it) => it.sentence.includes("___") && it.answer)
      // Drop items where the answer would duplicate the word next to the blank
      // (a model slip, e.g. "Many business ___" answered "businesses").
      .filter((it) => blankIsClean(it.sentence, it.answer))
      .slice(0, 8);
    res.status(200).json({ items });
  } catch (err) {
    res.status(500).json({ error: String((err && err.message) || err) });
  }
};
