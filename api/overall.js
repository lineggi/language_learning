// Vercel serverless function: an overall assessment across the 3 writing
// answers, plus ideas for building writing skill. Same-origin: POST /api/overall.
// The Gemini key lives only here (Vercel env var GEMINI_API_KEY).

const OVERALL_SCHEMA = {
  type: "object",
  properties: {
    // 총평: what the recurring problems are and how to improve next time.
    overall: { type: "string" },
    strengths: { type: "array", items: { type: "string" } },
    improvements: { type: "array", items: { type: "string" } },
    // Ideas / methods for building English writing skill.
    ideas: { type: "array", items: { type: "string" } },
  },
  required: ["overall", "improvements", "ideas"],
};

function buildPrompt(items) {
  const list = (items || [])
    .map((it, i) => `문항 ${i + 1}
QUESTION: ${it.question || "(none)"}
LEARNER ANSWER: ${it.userAnswer || "(빈칸)"}
SCORE: ${it.score == null ? "-" : it.score}/100
FEEDBACK: ${it.summary || "-"}`)
    .join("\n\n");

  return `You are a kind, precise English writing coach for a Korean learner (level B2–C1).
Below are the learner's answers to 3 English writing prompts about news articles, with each answer's score and short feedback.

${list}

Write an OVERALL assessment across all 3 answers as a coach. Look for RECURRING patterns
(e.g. article/preposition mistakes, verb tense, awkward word order, vocabulary that doesn't fit,
answers that don't fully address the question) rather than repeating single-item feedback.

Write EVERYTHING in KOREAN (존댓말), warm but specific. Keep any example English words/phrases in English.

Return JSON:
{
  "overall": "<총평: 2~4문장. 지금 반복되는 핵심 문제가 무엇이고, 다음 번에 어떤 점에 집중해서 개선하면 좋을지 구체적으로.>",
  "strengths": ["<잘한 점 1~2개, 짧게>"],
  "improvements": ["<다음에 고치면 좋을 구체적 포인트 3~4개. 각 항목은 한 문장, 실천 가능하게.>"],
  "ideas": ["<영작 실력을 키우는 구체적 학습 방법·아이디어 4~5개. 예: 매일 3문장 일기 영작, 오늘 배운 단어로 예문 만들기, 원문 문장 필사·모방(패턴 훔치기), 교정본을 소리 내어 읽기, 같은 답을 다시 써보고 비교하기 등. 이 학습자의 뉴스 리딩 앱 맥락에 맞게.>"]
}`;
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") { res.status(405).json({ error: "Use POST" }); return; }

  const key = (process.env.GEMINI_API_KEY || "").trim();
  if (!key) { res.status(500).json({ error: "GEMINI_API_KEY is not configured on the server." }); return; }
  const model = (process.env.GEMINI_MODEL || "gemini-2.5-flash").trim();

  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch { body = {}; } }
  const items = (body && Array.isArray(body.items) ? body.items : []).filter((it) => it && String(it.userAnswer || "").trim());
  if (!items.length) { res.status(400).json({ error: "No answers to assess." }); return; }

  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`;
    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: buildPrompt(items) }] }],
        generationConfig: { temperature: 0.6, responseMimeType: "application/json", responseSchema: OVERALL_SCHEMA },
      }),
    });
    if (!r.ok) { const t = await r.text(); res.status(502).json({ error: `Gemini ${r.status}`, detail: t.slice(0, 300) }); return; }
    const data = await r.json();
    const text = data?.candidates?.[0]?.content?.parts?.map((p) => p.text).join("") || "{}";
    let out; try { out = JSON.parse(text); } catch { res.status(502).json({ error: "Could not parse model output", raw: text.slice(0, 300) }); return; }
    out.overall = String(out.overall || "").trim();
    out.strengths = Array.isArray(out.strengths) ? out.strengths : [];
    out.improvements = Array.isArray(out.improvements) ? out.improvements : [];
    out.ideas = Array.isArray(out.ideas) ? out.ideas : [];
    res.status(200).json(out);
  } catch (err) {
    res.status(500).json({ error: String((err && err.message) || err) });
  }
};
