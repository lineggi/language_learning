const { test } = require("node:test");
const assert = require("node:assert/strict");

/*
 * /api/define is where a word collected on demand gets its definition, and the
 * flashcard then shows that definition and asks for the word — so it must not
 * contain the word. The prompt says so; these cover what happens when the
 * model ignores it, which measurably happens to about one entry in forty.
 */
process.env.GEMINI_API_KEY = "test-key";
const handler = require("../api/define.js");

// Minimal stand-ins for Vercel's req/res.
const mkRes = () => {
  const res = { code: null, body: null };
  res.status = (c) => { res.code = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  return res;
};
const reply = (obj) => ({
  ok: true,
  json: async () => ({ candidates: [{ content: { parts: [{ text: JSON.stringify(obj) }] } }] }),
});
// Answer each successive call with the next scripted reply.
function stubGemini(replies) {
  const prompts = [];
  global.fetch = async (_url, init) => {
    prompts.push(JSON.parse(init.body).contents[0].parts[0].text);
    const next = replies[Math.min(prompts.length - 1, replies.length - 1)];
    return typeof next === "function" ? next() : next;
  };
  return prompts;
}
const call = async (word = "traditional") => {
  const res = mkRes();
  await handler({ method: "POST", body: { word, passage: "" } }, res);
  return res;
};
const DEF = (meaning, word = "traditional") =>
  reply({ word, meaning, ko: "전통적인", example: `A ${word} market.`, pos: "adjective" });

const CLEAN = "Long established and handed down over many years.";
const LEAKY = "Existing in or as part of a tradition; long-established.";

test("a clean definition is returned as-is, with one call", async () => {
  const prompts = stubGemini([DEF(CLEAN)]);
  const res = await call();
  assert.equal(res.code, 200);
  assert.equal(res.body.meaning, CLEAN);
  assert.equal(prompts.length, 1, "no retry when there is nothing wrong");
});

test("a definition containing its own word is asked again, and the clean one wins", async () => {
  const prompts = stubGemini([DEF(LEAKY), DEF(CLEAN)]);
  const res = await call();
  assert.equal(res.code, 200);
  assert.equal(res.body.meaning, CLEAN);
  assert.equal(prompts.length, 2);
  assert.match(prompts[1], /previous answer was rejected/, "the retry says what was wrong");
  assert.ok(prompts[1].includes(LEAKY), "and quotes the rejected definition back");
});

test("if the retry leaks too, the word still gets a definition", async () => {
  // Losing the word entirely would be worse than a weak gloss.
  const prompts = stubGemini([DEF(LEAKY), DEF("About tradition in general.")]);
  const res = await call();
  assert.equal(res.code, 200);
  assert.equal(res.body.meaning, LEAKY, "falls back to the first answer");
  assert.equal(prompts.length, 2, "and does not keep retrying");
});

test("the check follows the word the model settled on, not the one tapped", async () => {
  // The reader taps "traditionally"; the model answers for the base form.
  const prompts = stubGemini([DEF(LEAKY, "traditional"), DEF(CLEAN, "traditional")]);
  const res = await call("traditionally");
  assert.equal(res.body.meaning, CLEAN);
  assert.equal(prompts.length, 2);
});

test("a short word is not retried over a lookalike", async () => {
  const prompts = stubGemini([DEF("The actual process of doing something.", "act")]);
  const res = await call("act");
  assert.equal(res.code, 200);
  assert.equal(prompts.length, 1, "'actual' must not count as leaking 'act'");
});

test("a model failure is still an error, not a silent retry loop", async () => {
  stubGemini([{ ok: false, status: 503, text: async () => "upstream down" }]);
  const res = await call();
  assert.equal(res.code, 502);
  assert.match(String(res.body.error), /503/);
});

test("unparseable output is reported rather than shipped", async () => {
  stubGemini([{ ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text: "not json" }] } }] }) }]);
  const res = await call();
  assert.equal(res.code, 502);
  assert.equal(res.body.error, "parse");
});
