// Vercel serverless function: generate multiple-choice distractors for an
// 오답노트 (grammar SRS) item, so reviewing a mistake is "pick the correct
// fix" instead of blind free-typing with no clue what to change. Keeps the
// Gemini key server-side. Same-origin: POST /api/errmc.

const MC_SCHEMA = {
  type: "object",
  properties: {
    distractors: { type: "array", items: { type: "string" } },
  },
  required: ["distractors"],
};

function buildPrompt({ before, after, category, why }) {
  return `You are writing a multiple-choice grammar quiz item for a Korean English learner.

The learner originally wrote (WRONG): "${before}"
The correct fix is: "${after}"
Mistake type: ${category || "기타"}
Why it's wrong (Korean): ${why || "(none)"}

Write exactly 3 DISTRACTORS — short alternative "fixes" that are WRONG but plausible, testing
the SAME grammar point (${category || "the same mistake type"}) so the learner must actually
know the rule to pick the real answer, not just spot an unrelated error. Each distractor must be
clearly different from "${after}" and from each other, similar in length/style to it, and must
NOT itself be a valid correct English sentence for this context.

Return JSON: { "distractors": ["<wrong option 1>", "<wrong option 2>", "<wrong option 3>"] }`;
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") { res.status(405).json({ error: "Use POST" }); return; }

  const key = (process.env.GEMINI_API_KEY || "").trim();
  if (!key) { res.status(500).json({ error: "GEMINI_API_KEY is not configured on the server." }); return; }
  const model = (process.env.GEMINI_MODEL || "gemini-2.5-flash").trim();

  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch { body = {}; } }
  const before = (body && body.before ? String(body.before) : "").trim();
  const after = (body && body.after ? String(body.after) : "").trim();
  const category = (body && body.category ? String(body.category) : "").trim();
  const why = (body && body.why ? String(body.why) : "").trim();
  if (!after) { res.status(400).json({ error: "No answer to build distractors for." }); return; }

  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`;
    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: buildPrompt({ before, after, category, why }) }] }],
        generationConfig: { temperature: 0.8, responseMimeType: "application/json", responseSchema: MC_SCHEMA },
      }),
    });
    if (!r.ok) { const t = await r.text(); res.status(502).json({ error: `Gemini ${r.status}`, detail: t.slice(0, 300) }); return; }
    const data = await r.json();
    const text = data?.candidates?.[0]?.content?.parts?.map((p) => p.text).join("") || "{}";
    let out; try { out = JSON.parse(text); } catch { res.status(502).json({ error: "Could not parse model output", raw: text.slice(0, 300) }); return; }
    const norm = (s) => String(s || "").trim().toLowerCase().replace(/\s+/g, " ").replace(/[.,!?;:'"()]/g, "");
    const seen = new Set([norm(after)]);
    const distractors = (Array.isArray(out.distractors) ? out.distractors : [])
      .map((d) => String(d || "").trim())
      .filter((d) => { const n = norm(d); if (!d || seen.has(n)) return false; seen.add(n); return true; })
      .slice(0, 3);
    res.status(200).json({ distractors });
  } catch (err) {
    res.status(500).json({ error: String((err && err.message) || err) });
  }
};
