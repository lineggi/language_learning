#!/usr/bin/env node
/*
 * test/browser/today.spec.js — 오늘의 추천 and its sections.
 *
 * The tab used to hardcode two of them, with 크립토 defined as "not economy",
 * so a third section would have been silently folded into crypto. It is now
 * driven by the CATEGORIES list; these scenarios hold that open, and cover the
 * days when a section produces nothing.
 *
 * Run:  npm run test:browser
 */
const { requirePlaywright, serve, pinnedPage, counter, flat } = require("./harness.js");
const { chromium } = requirePlaywright();

const PORT = Number(process.env.PORT || 8131);
const BASE = `http://127.0.0.1:${PORT}`;
const t = counter();
const ok = t.ok;

const DATE = "2026-10-07";
const pack = (prefix, rank, category, title) => ({
  id: `${prefix}-${DATE}-${rank - (category === "economy" ? 3 : category === "korea" ? 6 : 0)}`,
  date: DATE, rank, category, title,
  source: "Daybreak Wire", url: `https://example.com/${prefix}${rank}`,
  hook: `${title} 한 줄 소개`, passage: "One. Two. Three.",
  sentences: [], glossary: {}, questions: [], modelAnswers: [],
});
const CRYPTO = [1, 2, 3].map((r) => pack("cd", r, "crypto", `Crypto story ${r}`));
const ECON = [4, 5, 6].map((r) => pack("ec", r, "economy", `Economy story ${r - 3}`));
const KOREA = [7, 8, 9].map((r) => pack("kr", r, "korea", `Korea story ${r - 6}`));

// Serve a feed of our own so the sections are exactly what each case needs.
async function openToday(browser, packs) {
  const page = await pinnedPage(browser, DATE, (m) => { t.failed++; console.log("PAGEERROR: " + m); });
  await page.route("**/packs.json*", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(packs) }));
  await page.goto(`${BASE}/index.html`, { waitUntil: "networkidle" });
  await page.waitForSelector("nav.tabbar", { timeout: 20000 });
  await page.waitForTimeout(400);
  return page;
}
const chipText = (p) => p.locator("main .toolbar .chip").allInnerTexts();
const cards = (p) => p.locator("main .rec, main .reccard").count();

(async () => {
  const server = await serve(PORT);
  const browser = await chromium.launch();

  console.log("all three sections show, in reading order");
  {
    const page = await openToday(browser, [...CRYPTO, ...ECON, ...KOREA]);
    const main = await page.locator("main").innerText();
    ok(/크립토 3/.test(main) && /경제 3/.test(main) && /한국경제 3/.test(main),
       `a chip per section (${flat(await chipText(page))})`);
    ok(/전체 9/.test(main), "전체 counts all nine");
    const headings = await page.locator("main .cat-label").allInnerTexts();
    ok(JSON.stringify(headings) === JSON.stringify(["◆ 크립토", "◆ 경제", "◆ 한국경제"]),
       `sections in order (${headings.join(" / ")})`);
    ok(/Korea story 1/.test(main), "Korea articles are listed");
    await page.close();
  }

  console.log("a section filters to only its own articles");
  {
    const page = await openToday(browser, [...CRYPTO, ...ECON, ...KOREA]);
    await page.locator('main .chip:has-text("한국경제")').first().click();
    await page.waitForTimeout(400);
    const main = await page.locator("main").innerText();
    ok(/Korea story 1/.test(main), "Korea articles stay");
    ok(!/Crypto story/.test(main) && !/Economy story/.test(main), "the other sections go");
    ok((await page.locator("main .cat-label").count()) === 0, "no section heading when filtered to one");
    await page.close();
  }

  console.log("a day where a section produced nothing");
  {
    const page = await openToday(browser, [...CRYPTO, ...ECON]); // korea failed to collect
    const main = await page.locator("main").innerText();
    ok(!/한국경제/.test(main), "no chip for a section with no articles");
    ok(/전체 6/.test(main) && /크립토 3/.test(main) && /경제 3/.test(main), "the rest are unaffected");
    await page.close();
  }
  {
    const page = await openToday(browser, KOREA); // only Korea came through
    const main = await page.locator("main").innerText();
    ok((await page.locator("main .toolbar .chip").count()) === 0, "one section needs no chips");
    ok((await page.locator("main .cat-label").count()) === 0, "nor a heading");
    ok(/Korea story 1/.test(main), "and its articles still show");
    await page.close();
  }

  console.log("packs from before the sections existed still appear");
  {
    // Older packs carry a category the app no longer lists, or none at all.
    const legacy = [{ ...pack("cd", 1, "crypto", "Legacy story"), category: undefined }];
    const page = await openToday(browser, legacy);
    ok(/Legacy story/.test(await page.locator("main").innerText()), "an uncategorised pack is not dropped");
    await page.close();
  }

  await browser.close();
  server.close();
  console.log(t.failed ? `\n${t.failed} check(s) failed.` : "\nAll 오늘의 추천 checks passed.");
  process.exit(t.failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
