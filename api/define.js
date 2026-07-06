// Vercel serverless function: on-demand definition for ANY word the reader taps
// that is not in the article's built-in glossary. Keeps the Gemini key server-side.

const DEFINE_SCHEMA = {
  type: "object",
  properties: {
    word: { type: "string" },
    meaning: { type: "string" },
    ko: { type: "string" },
    example: { type: "string" },
  },
  required: ["word", "meaning", "ko", "example"],
};

module.exports = async function handler(req, res) {
  if (req.method !== "POST") { res.status(405).json({ error: "Use POST" }); return; }

  // Trim to guard against a trailing newline/space pasted into the env var,
  // which would corrupt the ?key= query and make Gemini return 400.
  const key = (process.env.GEMINI_API_KEY || "").trim();
  if (!key) { res.status(500).json({ error: "GEMINI_API_KEY is not configured on the server." }); return; }
  const model = (process.env.GEMINI_MODEL || "gemini-2.5-flash").trim();

  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch { body = {}; } }
  const word = (body && body.word ? String(body.word) : "").trim();
  const passage = (body && body.passage ? String(body.passage) : "").slice(0, 1500);
  if (!word) { res.status(400).json({ error: "No word." }); return; }

  const prompt = `Define the English word "${word}" for a Korean B2–C1 learner.
ALWAYS give the word's normal dictionary meaning. If the passage below uses it, prefer that sense; if the word is not in the passage, just give its common general meaning. NEVER say the word is absent or cannot be defined — always return a real definition.

PASSAGE (optional context):
${passage || "(none)"}

Return JSON: {
  "word": "<base/dictionary form of the word, lowercase>",
  "meaning": "<a clear definition in SIMPLE English — one short sentence of about 8 to 16 words. English only, no Korean. Do not use hard words.>",
  "ko": "<the word's meaning in KOREAN — a short, natural Korean gloss (e.g. 정당성, 합법성 / 완화하다). Korean only, a few words, no English.>",
  "example": "<one short, natural English example sentence (max ~14 words) that uses the word \\"${word}\\" itself>"
}`;

  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`;
    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.3, responseMimeType: "application/json", responseSchema: DEFINE_SCHEMA },
      }),
    });
    if (!r.ok) { const t = await r.text(); res.status(502).json({ error: `Gemini ${r.status}`, detail: t.slice(0, 200) }); return; }
    const data = await r.json();
    const text = data?.candidates?.[0]?.content?.parts?.map((p) => p.text).join("") || "{}";
    let out; try { out = JSON.parse(text); } catch { res.status(502).json({ error: "parse", raw: text.slice(0, 200) }); return; }
    out.word = String(out.word || word).toLowerCase().trim();
    out.meaning = String(out.meaning || "").trim();
    out.ko = String(out.ko || "").trim();
    out.example = String(out.example || "").trim();
    res.status(200).json(out);
  } catch (err) {
    res.status(500).json({ error: String((err && err.message) || err) });
  }
};
