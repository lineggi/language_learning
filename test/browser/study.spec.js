#!/usr/bin/env node
/*
 * test/browser/study.spec.js — flashcard study session, driven as a real user.
 *
 * The wordbank study session is the one place where correctness depends on
 * pointer events, CSS transitions and React commit timing all lining up, so a
 * pure unit test cannot see the failure this suite exists to prevent: swiping
 * at a natural pace silently dropped roughly half the answers, because the card
 * was still transitioning back from where the finger let go and the next swipe
 * landed on empty space. A learner marked ten words 알아요 and found four of
 * them still 미암기.
 *
 * Run:  npm run test:browser        (needs Playwright + network for the CDN)
 * Installs on demand:  npx playwright install chromium
 */
const http = require("http");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..", "..");
const PORT = Number(process.env.PORT || 8123);
const BASE = `http://127.0.0.1:${PORT}`;
const TYPES = { ".html": "text/html", ".js": "application/javascript", ".json": "application/json",
                ".png": "image/png", ".svg": "image/svg+xml", ".webmanifest": "application/manifest+json" };

let chromium;
try { ({ chromium } = require("playwright")); }
catch (e) {
  console.error("Playwright is not installed — skipping the browser suite.");
  console.error("  npm i -D playwright && npx playwright install chromium");
  process.exit(0);
}

const today = () => new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
const ago = (n) => new Date(Date.now() + 9 * 3600e3 - n * 86400e3).toISOString().slice(0, 10);
const bankOf = (n, extra = {}) => Object.fromEntries(
  Array.from({ length: n }, (_, i) => [`word${String(i + 1).padStart(2, "0")}`,
    { meaning: `meaning ${i + 1}`, pos: "noun", stage: "new", addedDate: today(), updatedAt: 1, ...extra }]));

let failed = 0;
const ok = (cond, msg) => { if (!cond) failed++; console.log(`${cond ? "  ok" : "NOT OK"} — ${msg}`); };

function serve() {
  return new Promise((resolve) => {
    const s = http.createServer((req, res) => {
      const url = decodeURIComponent(req.url.split("?")[0]);
      const file = path.join(ROOT, url === "/" ? "index.html" : url);
      if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
        res.writeHead(404); res.end("not found"); return;
      }
      res.writeHead(200, { "Content-Type": TYPES[path.extname(file)] || "text/plain", "Cache-Control": "no-store" });
      fs.createReadStream(file).pipe(res);
    });
    s.listen(PORT, () => resolve(s));
  });
}

// Open the wordbank with a seeded set of words and start a study session.
async function startSession(page, bank, button = /단어 외우기/) {
  await page.goto(`${BASE}/index.html`);
  await page.evaluate((b) => localStorage.setItem("dbw:wordbank", JSON.stringify(b)), bank);
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForSelector("nav.tabbar", { timeout: 20000 });
  await page.locator('nav.tabbar button:has-text("단어장")').first().click();
  await page.waitForTimeout(400);
  await page.locator("main button").filter({ hasText: button }).first().click();
  await page.waitForTimeout(400);
}

// A real drag across the card, then `gapMs` before the caller swipes again.
// The gap is the whole point: it is what used to decide whether the answer
// registered at all.
async function swipe(page, dir, gapMs) {
  const card = page.locator(".flashcard:not(.flying)").first();
  const box = await card.boundingBox();
  if (!box) return false;
  const y = box.y + box.height / 2;
  const [from, to] = dir === "yes" ? [0.25, 0.95] : [0.75, 0.05];
  await page.mouse.move(box.x + box.width * from, y);
  await page.mouse.down();
  for (let i = 1; i <= 4; i++) await page.mouse.move(box.x + box.width * (from + (to - from) * i / 4), y);
  await page.mouse.up();
  await page.waitForTimeout(gapMs);
  return true;
}

const stagesOf = (page) => page.evaluate(() => {
  const wb = JSON.parse(localStorage.getItem("dbw:wordbank") || "{}");
  const out = {};
  for (const v of Object.values(wb)) { const s = v.stage || "new"; out[s] = (out[s] || 0) + 1; }
  return out;
});

(async () => {
  const server = await serve();
  const browser = await chromium.launch();
  const pageErrors = [];
  const newPage = async () => {
    const p = await browser.newPage({ viewport: { width: 390, height: 900 } });
    p.on("pageerror", (e) => pageErrors.push(e.message));
    return p;
  };

  console.log("every answer registers, at any swiping speed");
  for (const gap of [0, 30, 80, 150, 400]) {
    const page = await newPage();
    await startSession(page, bankOf(10));
    for (let i = 0; i < 10; i++) if (!(await swipe(page, "yes", gap))) break;
    await page.waitForTimeout(600);
    const st = await stagesOf(page);
    ok((st.review || 0) === 10 && !st.new, `10 swipes ${gap}ms apart → 10 marked, 0 left 미암기 (${JSON.stringify(st)})`);
    await page.close();
  }

  console.log("each answer lands on the card that was showing");
  {
    const page = await newPage();
    await startSession(page, bankOf(6));
    for (let i = 0; i < 6; i++) await swipe(page, i % 2 ? "no" : "yes", 30);
    await page.waitForTimeout(600);
    const st = await stagesOf(page);
    ok((st.review || 0) === 3 && (st.new || 0) === 3, `알아요/몰라요 alternating → 3 복습중 / 3 미암기 (${JSON.stringify(st)})`);
    await page.close();
  }
  {
    const page = await newPage();
    await startSession(page, bankOf(5, { stage: "review", reviewSince: ago(5) }), /복습하기/);
    for (let i = 0; i < 5; i++) await swipe(page, "yes", 30);
    await page.waitForTimeout(600);
    ok((await stagesOf(page)).mastered === 5, "복습중 words swiped quickly all reach 완료");
    await page.close();
  }

  console.log("keyboard answers behave the same");
  {
    const page = await newPage();
    await startSession(page, bankOf(8));
    for (let i = 0; i < 8; i++) { await page.keyboard.press("ArrowRight"); await page.waitForTimeout(30); }
    await page.waitForTimeout(600);
    ok((await stagesOf(page)).review === 8, "8 quick → presses mark 8 words");
    await page.close();
  }
  {
    const page = await newPage();
    await startSession(page, bankOf(6));
    await page.keyboard.down("ArrowRight");
    await page.waitForTimeout(1200); // auto-repeat
    await page.keyboard.up("ArrowRight");
    await page.waitForTimeout(400);
    ok((await stagesOf(page)).review === 1, "holding → answers one card, not the whole deck");
    await page.close();
  }

  console.log("되돌리기 restores the word exactly");
  {
    const page = await newPage();
    await startSession(page, bankOf(3));
    await swipe(page, "yes", 400);
    ok((await stagesOf(page)).review === 1, "one 알아요 → 복습중 1");
    await page.locator("main button").filter({ hasText: /되돌리기/ }).first().click();
    await page.waitForTimeout(500);
    const st = await stagesOf(page);
    ok((st.new || 0) === 3 && !st.review, `undo puts the stage back (${JSON.stringify(st)})`);
    ok(/1 \/ 3/.test(await page.locator("main").innerText()), "undo steps back to the same card");
    await page.close();
  }

  ok(pageErrors.length === 0, `no page errors (${pageErrors.slice(0, 3).join(" | ") || "none"})`);

  await browser.close();
  server.close();
  console.log(failed ? `\n${failed} check(s) failed.` : "\nAll browser checks passed.");
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
