#!/usr/bin/env node
/*
 * test/browser/collect.spec.js — the words a reader taps must all be accounted for.
 *
 * Tapped words are collected when the article is completed: those the article
 * glossary covers are saved directly, the rest are defined through /api/define.
 * That lookup can fail — no server configured, a 500, a timeout — and when it
 * did, the failures were dropped by a bare `.filter(Boolean)` while the toast
 * counted only the successes. A learner tapped six words, read
 * "1개 단어를 단어장에 담았어요", and the other five were simply gone.
 *
 * These scenarios pin the contract: nothing disappears without being named,
 * and whatever failed can be retried.
 *
 * Run:  npm run test:browser
 */
const { requirePlaywright, serve, pinnedPage, counter, flat } = require("./harness.js");
const { chromium } = requirePlaywright();

const PORT = Number(process.env.PORT || 8127);
const BASE = `http://127.0.0.1:${PORT}`;
const t = counter();
const ok = t.ok;

// Open an article and tap `count` words while reading.
async function readAndTap(page, count) {
  await page.goto(`${BASE}/index.html`);
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForSelector("nav.tabbar", { timeout: 20000 });
  await page.evaluate(() => {
    window.__toasts = [];
    new MutationObserver(() => {
      const el = document.querySelector(".toast");
      if (el && window.__toasts[window.__toasts.length - 1] !== el.innerText) window.__toasts.push(el.innerText);
    }).observe(document.body, { childList: true, subtree: true });
  });
  await page.locator("main button").filter({ hasText: /읽기/ }).first().click();
  await page.waitForTimeout(600);
  const words = page.locator(".passage .w");
  for (let i = 0; i < count; i++) await words.nth(i * 3).click();
  await page.waitForTimeout(300);
  for (let i = 0; i < 5; i++) { await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight)); await page.waitForTimeout(700); }
  await page.locator("main button").filter({ hasText: /완독/ }).first().click();
  await page.waitForTimeout(2500);
}
const bankSize = (p) => p.evaluate(() => Object.keys(JSON.parse(localStorage.getItem("dbw:wordbank") || "{}")).length);
const toasts = (p) => p.evaluate(() => window.__toasts || []);
// The words the panel says it could not save.
async function unsavedWords(p) {
  const el = p.locator(".unsaved .unsaved-w");
  if (!(await el.count())) return [];
  return (await el.innerText()).split(",").map((w) => w.trim()).filter(Boolean);
}
// Stand in for /api/define. `isUp()` decides whether this call succeeds, so a
// scenario can bring the server back partway through.
async function stubDefine(page, isUp) {
  await page.route("**/api/define", (route) => {
    if (!isUp()) return route.fulfill({ status: 500, contentType: "text/plain", body: "boom" });
    const word = JSON.parse(route.request().postData() || "{}").word || "x";
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({
      word: String(word).toLowerCase(), meaning: "정의 " + word, ko: "뜻", example: "An example.", pos: "noun" }) });
  });
}

(async () => {
  const server = await serve(PORT);
  const browser = await chromium.launch();
  const newPage = () => pinnedPage(browser, "2026-09-29", (m) => { t.failed++; console.log("PAGEERROR: " + m); });
  const TAPS = 6;
  // Taps are deduplicated by lemma before collection, so the number of entries
  // is <= the number of taps. Every scenario taps the same article at the same
  // positions, which makes that number stable across them.
  let entries = 0;

  console.log("a failed lookup is reported, never silently dropped");
  {
    const page = await newPage();
    // /api/define is unreachable here, so only glossary-backed words can save.
    await readAndTap(page, TAPS);
    const saved = await bankSize(page);
    const listed = (await unsavedWords(page)).length;
    entries = saved + listed;
    ok(listed > 0, `some taps needed the server (${listed}) — the case under test`);
    ok(entries > 0 && entries <= TAPS, `${TAPS} taps became ${entries} entries`);
    const said = (await toasts(page)).join(" ");
    const m = said.match(/(\d+)개는 뜻을 못 불러왔어요/);
    ok(!!m, `the toast names the failures (${said})`);
    ok(m && Number(m[1]) === listed, `and counts them right (${m ? m[1] : "-"} vs ${listed})`);
    await page.close();
  }

  console.log("and they stay on screen with a way to try again");
  {
    const page = await newPage();
    await readAndTap(page, TAPS);
    const panel = page.locator(".unsaved");
    ok((await panel.count()) === 1, "the unsaved panel is shown");
    const listed = (await unsavedWords(page)).length;
    const text = flat(await panel.innerText());
    ok(new RegExp(`담기지 못한 단어 ${listed}개`).test(text), `it counts them (${text})`);
    ok((await panel.locator("button").innerText()).includes("다시 시도"), "with a retry button");

    // Retry while the endpoint is still down: the words must survive, and the
    // learner must be told again rather than the panel quietly emptying.
    const saved = await bankSize(page);
    await panel.locator("button").click();
    await page.waitForTimeout(2000);
    ok((await page.locator(".unsaved").count()) === 1, "a failed retry keeps them listed");
    ok((await unsavedWords(page)).length === listed, "with the same words");
    ok(await bankSize(page) === saved, "and adds nothing");
    ok(/못 불러왔어요/.test((await toasts(page)).slice(-1)[0] || ""), "and says so again");
    await page.close();
  }

  console.log("a working server saves every tapped word");
  {
    const page = await newPage();
    await stubDefine(page, () => true);
    await readAndTap(page, TAPS);
    ok((await page.locator(".unsaved").count()) === 0, "nothing is left unsaved");
    const n = await bankSize(page);
    ok(n === entries, `all ${entries} entries are in the wordbank (${n})`);
    const said = (await toasts(page)).join(" ");
    ok(!/못 불러왔어요/.test(said), `and no failure is reported (${said})`);
    await page.close();
  }

  console.log("a retry after the server comes back saves the rest");
  {
    const page = await newPage();
    let up = false;
    await stubDefine(page, () => up);
    await readAndTap(page, TAPS);
    const partial = await bankSize(page);
    ok((await page.locator(".unsaved").count()) === 1, "a 500 leaves them listed");
    up = true;
    await page.locator(".unsaved button").click();
    await page.waitForTimeout(2000);
    ok((await page.locator(".unsaved").count()) === 0, "the retry clears the panel");
    ok(await bankSize(page) === entries, `and every entry lands (${partial} → ${await bankSize(page)}, expected ${entries})`);
    await page.close();
  }

  console.log("a failing endpoint never shows a raw exception");
  {
    const page = await newPage();
    await readAndTap(page, 1);
    await page.locator("main textarea").first().fill("This is my answer to the question.");
    const grade = page.locator("main button").filter({ hasText: /AI 채점/ }).first();
    if (await grade.count()) { await grade.click(); await page.waitForTimeout(2500); }
    const body = await page.locator("main").innerText();
    ok(!/Unexpected token|is not valid JSON|SyntaxError|\[object/.test(body), "no parser exception on screen");
    const shown = (body.match(/[^\n]*(준비되지|연결하지|서버 오류|많아요)[^\n]*/g) || []).join(" | ");
    ok(shown.length > 0, `a readable reason instead (${shown || "none"})`);
    await page.close();
  }

  await browser.close();
  server.close();
  console.log(t.failed ? `\n${t.failed} check(s) failed.` : "\nAll collection checks passed.");
  process.exit(t.failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
