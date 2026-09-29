#!/usr/bin/env node
/*
 * test/browser/wordbook.spec.js — 단어장: the two structures a learner can pick.
 *
 *   진도별  the original flow: 미암기 → 복습중 → 완료
 *   주차별  the same words grouped into Mon–Fri wordbooks, reviewed together
 *           over the weekend
 *
 * Every assertion here depends on what day it is in KST, so the page's clock is
 * pinned per scenario (see harness.js) rather than left to the wall clock.
 *
 * Run:  npm run test:browser
 */
const { requirePlaywright, serve, pinnedPage, counter, flat } = require("./harness.js");
const { chromium } = requirePlaywright();

const PORT = Number(process.env.PORT || 8125);
const BASE = `http://127.0.0.1:${PORT}`;
const t = counter();
const ok = t.ok;

// Words across three KST weeks, plus one saved before dates were recorded.
const BANK = {
  // 10월 1주차 · Mon 9/28 – Fri 10/2
  alpha:   { meaning: "a", pos: "noun", stage: "new",      addedDate: "2026-09-28", updatedAt: 1 },
  bravo:   { meaning: "b", pos: "noun", stage: "new",      addedDate: "2026-09-29", updatedAt: 1 },
  charlie: { meaning: "c", pos: "verb", stage: "review",   addedDate: "2026-10-01", reviewSince: "2026-10-01", updatedAt: 1 },
  delta:   { meaning: "d", pos: "noun", stage: "mastered", addedDate: "2026-10-02", updatedAt: 1 },
  // 10월 2주차 · Mon 10/5 – Thu 10/8
  echo:    { meaning: "e", pos: "noun", stage: "new",      addedDate: "2026-10-05", updatedAt: 1 },
  foxtrot: { meaning: "f", pos: "noun", stage: "new",      addedDate: "2026-10-08", updatedAt: 1 },
  // 9월 4주차
  golf:    { meaning: "g", pos: "noun", stage: "new",      addedDate: "2026-09-21", updatedAt: 1 },
  // a word from before addedDate was stored
  hotel:   { meaning: "h", pos: "noun", stage: "new", updatedAt: 1 },
};

async function openWordbank(browser, kstDate, mode = "week") {
  const page = await pinnedPage(browser, kstDate, (m) => { t.failed++; console.log("PAGEERROR: " + m); });
  await page.goto(`${BASE}/index.html`);
  await page.evaluate(([bank, m]) => {
    localStorage.setItem("dbw:wordbank", JSON.stringify(bank));
    localStorage.setItem("dbw:wbmode", JSON.stringify(m));
  }, [BANK, mode]);
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForSelector("nav.tabbar", { timeout: 20000 });
  await page.locator('nav.tabbar button:has-text("단어장")').first().click();
  await page.waitForTimeout(500);
  return page;
}
const chips = (page) => page.locator(".weekchip").allInnerTexts();
const weekDeckBtn = (page) => page.locator("main button.btn.primary.studybtn").filter({ hasText: /몰아서 외우기/ });

(async () => {
  const server = await serve(PORT);
  const browser = await chromium.launch();

  console.log("진도별 keeps the original structure exactly");
  {
    const page = await openWordbank(browser, "2026-10-08", "stage");
    const main = await page.locator("main").innerText();
    ok(/단어 외우기 · 미암기 6개/.test(main), "미암기 deck unchanged");
    ok(/복습하기/.test(main), "복습하기 unchanged");
    ok(/전체 8/.test(main), "counts span the whole wordbank");
    ok((await page.locator(".weekchip").count()) === 0, "no week chips in this mode");
    await page.close();
  }

  console.log("the choice between structures is the learner's, and it sticks");
  {
    const page = await openWordbank(browser, "2026-10-08", "stage");
    await page.locator('.modeswitch button:has-text("주차별")').click();
    await page.waitForTimeout(400);
    ok((await page.locator(".weekchip").count()) > 0, "주차별 shows the weekly wordbooks");
    ok(!/단어 외우기 · 미암기/.test(await page.locator("main").innerText()), "and hides the 진도별 decks");
    await page.reload({ waitUntil: "networkidle" });
    await page.locator('nav.tabbar button:has-text("단어장")').first().click();
    await page.waitForTimeout(500);
    ok((await page.locator(".modeswitch button.active").innerText()).includes("주차별"), "survives a reload");
    await page.locator('.modeswitch button:has-text("진도별")').click();
    await page.waitForTimeout(300);
    ok(/단어 외우기 · 미암기 6개/.test(await page.locator("main").innerText()), "and switches back");
    await page.close();
  }

  console.log("주차별 groups existing words by the KST week they were collected");
  {
    const page = await openWordbank(browser, "2026-10-08"); // Thursday
    const c = await chips(page);
    console.log("    " + c.map(flat).join("\n    "));
    ok(c.length === 4, `three weeks plus the undated bucket (${c.length})`);
    ok(/10월 2주차 · 이번 주/.test(c[0]) && /10\/5–10\/11 · 2개/.test(c[0]), "this week is 10월 2주차");
    ok(/10월 1주차/.test(c[1]) && /9\/28–10\/4 · 4개 · 완료 1/.test(c[1]), "10월 1주차 · 4 words · 1 완료");
    ok(/9월 4주차/.test(c[2]) && /9\/21–9\/27 · 1개/.test(c[2]), "9월 4주차");
    ok(/날짜 미상/.test(c[3]), "words with no collection date are still reachable");
    ok((await page.locator(".weekendcard").count()) === 0, "no weekend prompt on a collecting day");

    await page.locator(".weekchip").nth(1).click();
    await page.waitForTimeout(400);
    // Grid cards show the meaning on the front; the word is behind a flip.
    const grid = await page.locator(".wgrid").innerText();
    ok((await page.locator(".wcard").count()) === 4, "the grid narrows to that week");
    ok(/\ba\b/.test(grid) && /\bd\b/.test(grid), "its words are there");
    ok(!/\be\b/.test(grid) && !/\bg\b/.test(grid), "other weeks are not");
    const bar = flat(await page.locator("main .toolbar").innerText());
    ok(/전체 4/.test(bar) && /미암기 2/.test(bar) && /복습중 1/.test(bar) && /완료 1/.test(bar),
       `stage chips describe that week (${bar})`);
    ok(/1\/8/.test(await page.locator("main").innerText()), "the headline total still spans everything");

    ok(/10월 1주차 4개 몰아서 외우기/.test(await weekDeckBtn(page).innerText()), "a deck for the whole week");
    await weekDeckBtn(page).click();
    await page.waitForTimeout(500);
    const head = flat(await page.locator(".studyhead").innerText());
    ok(/10월 1주차/.test(head) && /1 \/ 4/.test(head), `all four, whatever their stage (${head})`);
    await page.close();
  }

  {
    const page = await openWordbank(browser, "2026-10-08");
    await page.locator(".weekchip").nth(3).click(); // 날짜 미상
    await page.waitForTimeout(400);
    ok((await page.locator(".wcard").count()) === 1, "the undated bucket lists its word");
    await weekDeckBtn(page).click();
    await page.waitForTimeout(500);
    ok(/1 \/ 1/.test(await page.locator(".studyhead").innerText()), "and can be studied like any week");
    await page.close();
  }

  console.log("the weekend reviews the week just collected");
  for (const [date, dow] of [["2026-10-10", "토요일"], ["2026-10-11", "일요일"]]) {
    const page = await openWordbank(browser, date);
    const card = page.locator(".weekendcard");
    ok((await card.count()) === 1, `${dow}: the weekend prompt appears`);
    const text = await card.innerText();
    ok(/10월 2주차 단어 2개/.test(text), `${dow}: it names this week and its size`);
    ok(/10\/5–10\/11/.test(text) && new RegExp(dow).test(text), `${dow}: with the span and the day`);
    await card.locator("button").click();
    await page.waitForTimeout(500);
    const head = flat(await page.locator(".studyhead").innerText());
    ok(/10월 2주차 복습/.test(head) && /1 \/ 2/.test(head), `${dow}: reviews that week's words (${head})`);
    await page.close();
  }

  {
    const page = await openWordbank(browser, "2026-10-17"); // Saturday, nothing collected
    ok((await page.locator(".weekendcard").count()) === 0, "a weekend with an empty week prompts nothing");
    ok((await chips(page)).length === 4, "earlier weeks stay selectable");
    ok(!/이번 주/.test((await chips(page)).join(" ")), "and none is marked 이번 주");
    await page.close();
  }
  {
    const page = await openWordbank(browser, "2026-10-12"); // Monday
    ok((await page.locator(".weekendcard").count()) === 0, "Monday starts collecting again, no prompt");
    await page.close();
  }

  await browser.close();
  server.close();
  console.log(t.failed ? `\n${t.failed} check(s) failed.` : "\nAll wordbook checks passed.");
  process.exit(t.failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
