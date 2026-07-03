// Vercel serverless function: AI grading + correction for a learner's answer.
// The Gemini key lives ONLY here (Vercel env var GEMINI_API_KEY), never in the
// browser. Same-origin call from the app: POST /api/grade.

const GRADE_SCHEMA = {
  type: "object",
  properties: {
    score: { type: "integer" },
    summary: { type: "string" },
    corrections: {
      type: "array",
      items: {
        type: "object",
        properties: {
          before: { type: "string" },
          after: { type: "string" },
          why: { type: "string" },
        },
        required: ["before", "after", "why"],
      },
    },
    revised: { type: "string" },
  },
  required: ["score", "summary", "corrections", "revised"],
};

function buildPrompt({ question, passage, modelAnswer, userAnswer }) {
  return `You are a kind, precise English writing tutor for a Korean learner (level B2–C1).
Grade the learner's written answer to a question about a news passage.

PASSAGE (context):
${passage || "(none)"}

QUESTION:
${question || "(none)"}

MODEL ANSWER (reference, not the only correct answer):
${modelAnswer || "(none)"}

LEARNER ANSWER:
${userAnswer}

Judge grammar, word choice, naturalness, and whether it actually answers the question.
Write ALL feedback text (summary and "why") in KOREAN, but keep the corrected English in English.
For "corrections", list the learner's actual wrong or awkward phrases and how to fix them —
be concrete ("이 부분을 이렇게 바꾸세요"). If the answer is basically empty or off-topic, score it low and say why.

Return JSON:
{
  "score": <integer 0-100>,
  "summary": "<one or two Korean sentences: overall assessment>",
  "corrections": [ { "before": "<learner's phrase>", "after": "<corrected English>", "why": "<short Korean reason>" } ],
  "revised": "<a clean, natural corrected version of the learner's whole answer, in English>"
}`;
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Use POST" });
    return;
  }

  const key = process.env.GEMINI_API_KEY;
  if (!key) {
    res.status(500).json({ error: "GEMINI_API_KEY is not configured on the server." });
    return;
  }
  const model = process.env.GEMINI_MODEL || "gemini-2.5-flash";

  let body = req.body;
  if (typeof body === "string") {
    try { body = JSON.parse(body); } catch { body = {}; }
  }
  const { question, passage, modelAnswer, userAnswer } = body || {};
  if (!userAnswer || !String(userAnswer).trim()) {
    res.status(400).json({ error: "Empty answer." });
    return;
  }

  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`;
    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: buildPrompt({ question, passage, modelAnswer, userAnswer }) }] }],
        generationConfig: { temperature: 0.4, responseMimeType: "application/json", responseSchema: GRADE_SCHEMA },
      }),
    });
    if (!r.ok) {
      const t = await r.text();
      res.status(502).json({ error: `Gemini ${r.status}`, detail: t.slice(0, 300) });
      return;
    }
    const data = await r.json();
    const text = data?.candidates?.[0]?.content?.parts?.map((p) => p.text).join("") || "{}";
    let out;
    try { out = JSON.parse(text); } catch {
      res.status(502).json({ error: "Could not parse model output", raw: text.slice(0, 300) });
      return;
    }
    // Clamp score defensively.
    out.score = Math.max(0, Math.min(100, parseInt(out.score, 10) || 0));
    res.status(200).json(out);
  } catch (err) {
    res.status(500).json({ error: String(err && err.message || err) });
  }
}
