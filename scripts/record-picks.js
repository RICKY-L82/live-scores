#!/usr/bin/env node
/*
 * Snapshot today's TOP3-per-section picks into data/picks-history/<date>.json
 * so scripts/settle-picks.js can later check them against real results.
 *
 * picks.js's candidate-generation logic (starters, lineups, odds fetching…)
 * only exists client-side and is too large/fetch-heavy to safely re-implement
 * in Node without risking drift from what a real visitor sees. Instead this
 * opens picks.html in a headless browser and reads back the exact same
 * window.__picksSections object render() in assets/js/picks.js exposes —
 * guaranteeing the recorded picks match the page 1:1.
 */
"use strict";

const fs = require("fs");
const http = require("http");
const path = require("path");
const { chromium } = require("playwright");

const ROOT = path.join(__dirname, "..");
const OUT_DIR = path.join(ROOT, "data", "picks-history");
const MIN_PROB = 0.5;
const TOP_N = 3;

const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json" };

// picks.js makes cross-origin fetch() calls to ESPN/MLB/etc; browsers treat
// a file:// page as a "null" origin and CORS-block those requests outright
// (confirmed the hard way — see git history), so this serves the repo over
// plain HTTP instead. That gives picks.html a real http:// origin, matching
// how those same fetches behave from the deployed GitHub Pages site.
function serveStatic() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const reqPath = decodeURIComponent(req.url.split("?")[0]);
      const filePath = path.join(ROOT, reqPath === "/" ? "/picks.html" : reqPath);
      if (!filePath.startsWith(ROOT)) { res.writeHead(403); res.end(); return; }
      fs.readFile(filePath, (err, data) => {
        if (err) { res.writeHead(404); res.end(); return; }
        res.writeHead(200, { "Content-Type": MIME[path.extname(filePath)] || "application/octet-stream" });
        res.end(data);
      });
    });
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

// Taiwan-date "today" — matches how a visitor of this site thinks about "today's picks"
function taipeiToday() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Taipei" }).format(new Date());
}

(async () => {
  const server = await serveStatic();
  const port = server.address().port;
  const browser = await chromium.launch();
  let sections;
  try {
    const page = await browser.newPage();
    page.on("console", (msg) => {
      if (msg.type() === "error") console.error("[page]", msg.text());
    });
    await page.goto("http://127.0.0.1:" + port + "/picks.html", { waitUntil: "load" });
    await page.waitForFunction(() => window.__picksReady === true, null, { timeout: 90000 });
    sections = await page.evaluate(() => window.__picksSections);
  } finally {
    await browser.close();
    server.close();
  }

  if (!sections) throw new Error("picks.html never set window.__picksSections");

  const trimmed = {};
  for (const key of Object.keys(sections)) {
    trimmed[key] = (sections[key] || [])
      .filter((c) => typeof c.prob === "number" && c.prob >= MIN_PROB)
      .slice(0, TOP_N)
      .map((c) => ({
        league: c.league, type: c.type, away: c.away, home: c.home,
        start: c.start, pick: c.pick, prob: c.prob, edge: c.edge, price: c.price,
        result: null,
      }));
  }

  const date = taipeiToday();
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const file = path.join(OUT_DIR, date + ".json");
  fs.writeFileSync(file, JSON.stringify({
    date,
    recordedAt: new Date().toISOString(),
    sections: trimmed,
  }, null, 2));

  const total = Object.values(trimmed).reduce((n, list) => n + list.length, 0);
  console.log("recorded " + total + " pick(s) across " + Object.keys(trimmed).length + " section(s) to " + file);
})().catch((e) => {
  console.error("record-picks failed:", e);
  process.exit(1);
});
