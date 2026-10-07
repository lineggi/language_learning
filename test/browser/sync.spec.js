#!/usr/bin/env node
/*
 * test/browser/sync.spec.js — study progress must survive a sync in flight.
 *
 * The push to Supabase is debounced, then does select() → upsert() and folds
 * the result back into local state. It used to ASSIGN that result:
 *
 *     setWordbank((loc) => (same(wb, loc) ? loc : wb));
 *
 * `wb` was computed from the wordbank as it stood before two network round
 * trips, so every word marked 외웠음 during that window was overwritten by the
 * older snapshot — reverted locally, then pushed to the server in that state.
 * A learner finished a ten-word deck and still saw words waiting, with no
 * pattern to it beyond how the network happened to line up.
 *
 * supabase-js is replaced with an in-memory stand-in whose latency the test
 * controls, so the window is wide and the race is deterministic rather than
 * something that shows up once in a while on a phone.
 *
 * Run:  npm run test:browser
 */
const { requirePlaywright, serve, pinnedPage, counter } = require("./harness.js");
const { chromium } = requirePlaywright();

const PORT = Number(process.env.PORT || 8129);
const BASE = `http://127.0.0.1:${PORT}`;
const t = counter();
const ok = t.ok;
const N = 10;

// Stands in for supabase-js: one in-memory row, every call answered after
// `latency` ms so a round trip can be held open while the user keeps studying.
const fakeSupabase = (latency) => `(() => {
  const LAT = ${latency};
  const wait = (v) => new Promise((r) => setTimeout(() => r(v), LAT));
  window.__sb = { row: null, selects: 0, upserts: 0 };
  const session = { user: { id: "test-user", email: "tester@example.com" } };
  const table = () => ({
    select() { return this; },
    eq() { return this; },
    async maybeSingle() { window.__sb.selects++; return wait({ data: window.__sb.row, error: null }); },
    async upsert(obj) {
      window.__sb.upserts++;
      return wait(null).then(() => { window.__sb.row = JSON.parse(JSON.stringify(obj)); return { error: null }; });
    },
  });
  window.supabase = { createClient: () => ({
    from: () => table(),
    auth: {
      getSession: async () => ({ data: { session } }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
      signInWithOAuth: async () => ({ error: null }),
      signOut: async () => ({ error: null }),
    },
  }) };
})();`;

async function swipeYes(page, gapMs) {
  const card = page.locator(".flashcard:not(.flying)").first();
  const box = await card.boundingBox();
  if (!box) return false;
  const y = box.y + box.height / 2;
  await page.mouse.move(box.x + box.width * 0.25, y);
  await page.mouse.down();
  for (let i = 1; i <= 4; i++) await page.mouse.move(box.x + box.width * (0.25 + 0.7 * i / 4), y);
  await page.mouse.up();
  await page.waitForTimeout(gapMs);
  return true;
}

async function studyWholeDeck(browser, { latency, gap }) {
  const page = await pinnedPage(browser, "2026-10-07", (m) => { t.failed++; console.log("PAGEERROR: " + m); });
  await page.addInitScript(fakeSupabase(latency));
  const bank = {};
  for (let i = 1; i <= N; i++) bank[`word${String(i).padStart(2, "0")}`] =
    { meaning: `meaning ${i}`, pos: "noun", stage: "new", addedDate: "2026-10-07", updatedAt: 1 };

  await page.goto(`${BASE}/index.html`);
  await page.evaluate((b) => {
    localStorage.setItem("dbw:wordbank", JSON.stringify(b));
    localStorage.setItem("dbw:wbmode", JSON.stringify("stage"));
  }, bank);
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForSelector("nav.tabbar", { timeout: 20000 });
  await page.waitForTimeout(latency + 600); // let the first pull finish so pushes are armed

  await page.locator('nav.tabbar button:has-text("단어장")').first().click();
  await page.waitForTimeout(400);
  await page.locator("main button").filter({ hasText: /단어 외우기/ }).first().click();
  await page.waitForTimeout(400);
  for (let i = 0; i < N; i++) if (!(await swipeYes(page, gap))) break;
  await page.waitForTimeout(latency * 4 + 3000); // every in-flight push lands

  const result = await page.evaluate(() => {
    const count = (wb) => Object.values(wb || {}).reduce((m, v) => {
      const s = v.stage || "new"; m[s] = (m[s] || 0) + 1; return m;
    }, {});
    return {
      local: count(JSON.parse(localStorage.getItem("dbw:wordbank") || "{}")),
      remote: window.__sb.row ? count(window.__sb.row.wordbank) : null,
    };
  });
  await page.close();
  return result;
}

(async () => {
  const server = await serve(PORT);
  const browser = await chromium.launch();

  // Swipe gaps from frantic to leisurely, at two network speeds. The original
  // fault showed at every one of them, including the slowest.
  const cases = [
    { latency: 600, gap: 60 }, { latency: 600, gap: 200 }, { latency: 600, gap: 700 },
    { latency: 2000, gap: 120 }, { latency: 2000, gap: 450 }, { latency: 2000, gap: 700 },
  ];
  console.log("a deck finished during a sync stays finished");
  for (const c of cases) {
    const r = await studyWholeDeck(browser, c);
    const left = r.local.new || 0;
    const remoteLeft = r.remote ? (r.remote.new || 0) : null;
    ok(left === 0 && (r.local.review || 0) === N,
       `지연 ${c.latency}ms · 간격 ${c.gap}ms — 로컬에 미암기 ${left}개 남음 (0이어야 함)`);
    ok(remoteLeft === 0,
       `지연 ${c.latency}ms · 간격 ${c.gap}ms — 서버에 미암기 ${remoteLeft}개 올라감 (0이어야 함)`);
  }

  await browser.close();
  server.close();
  console.log(t.failed ? `\n${t.failed} check(s) failed.` : "\nAll sync checks passed.");
  process.exit(t.failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
