/*
 * Shared plumbing for the browser specs: a static server over the repo, a
 * Playwright page whose clock is pinned to a chosen KST date, and a tiny
 * assertion counter. Kept here so each spec is just its scenarios.
 */
const http = require("http");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..", "..");
const TYPES = { ".html": "text/html", ".js": "application/javascript", ".json": "application/json",
                ".png": "image/png", ".svg": "image/svg+xml", ".webmanifest": "application/manifest+json" };

function requirePlaywright() {
  try { return require("playwright"); }
  catch (e) {
    console.error("Playwright is not installed — skipping the browser suite.");
    console.error("  npm i -D playwright && npx playwright install chromium");
    process.exit(0);
  }
}

function serve(port) {
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
    s.listen(port, () => resolve(s));
  });
}

// Freeze the page's clock at 10:00 KST on `kstDate`, so "today", the KST day
// boundary and the weekday are all decided by the test rather than by when it
// happens to run.
async function pinnedPage(browser, kstDate, onError) {
  const page = await browser.newPage({ viewport: { width: 390, height: 900 } });
  const t = Date.parse(`${kstDate}T10:00:00+09:00`);
  await page.addInitScript((t) => {
    const R = Date;
    const D = function (...a) { return a.length ? new R(...a) : new R(t); };
    D.now = () => t; D.parse = R.parse; D.UTC = R.UTC; D.prototype = R.prototype;
    window.Date = D;
  }, t);
  page.on("pageerror", (e) => onError(e.message));
  return page;
}

function counter() {
  const state = { failed: 0 };
  state.ok = (cond, msg) => { if (!cond) state.failed++; console.log(`${cond ? "  ok" : "NOT OK"} — ${msg}`); };
  return state;
}

const flat = (t) => String(t).replace(/\n/g, " | ");

module.exports = { ROOT, requirePlaywright, serve, pinnedPage, counter, flat };
