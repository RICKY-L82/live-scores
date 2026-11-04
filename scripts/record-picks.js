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

// From GitHub Actions, ESPN answers the headless browser without an
// Access-Control-Allow-Origin header, so every ESPN fetch in picks.js failed
// CORS and collectNba() came back empty — no NBA pick was ever recorded.
// Plain Node fetch from the same runner works (scripts/collect-nba-stats.js
// hits the same API every 20 minutes), so ESPN requests are proxied through
// Node instead of left to the browser.
const ESPN_URL = /^https:\/\/site(\.web)?\.api\.espn\.com\//;
async function proxyEspn(route) {
  try {
    const res = await fetch(route.request().url(), { signal: AbortSignal.timeout(20000) });
    await route.fulfill({
      status: res.status,
      headers: { "content-type": res.headers.get("content-type") || "application/json", "access-control-allow-origin": "*" },
      body: Buffer.from(await res.arrayBuffer()),
    });
  } catch (e) {
    console.error("[espn proxy] " + route.request().url() + ": " + e.message);
    await route.abort();
  }
}

// Taiwan-date "today" — matches how a visitor of this site thinks about "today's picks"
function taipeiToday() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Taipei" }).format(new Date());
}

// NBA games not yet started today (ET) that ESPN already has odds for — if
// there are some but picks.js produced no NBA candidate at all, its data
// fetching failed (collectNba() swallows errors) rather than "no +EV pick"
async function upcomingNbaGamesWithOdds() {
  const etDate = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(new Date()).replace(/-/g, "");
  const res = await fetch("https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard?dates=" + etDate,
    { signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error("HTTP " + res.status);
  const data = await res.json();
  const now = Date.now();
  return (data.events || []).filter((ev) => {
    const comp = ev.competitions && ev.competitions[0];
    return comp && comp.status && comp.status.type && comp.status.type.state === "pre" &&
      new Date(ev.date).getTime() > now && Array.isArray(comp.odds) && comp.odds.length > 0;
  }).length;
}

function countPicks(sections) {
  return Object.values(sections || {}).reduce((n, list) => n + (Array.isArray(list) ? list.length : 0), 0);
}

(async () => {
  const server = await serveStatic();
  const port = server.address().port;
  const browser = await chromium.launch();
  let sections, nbaCandidates;
  try {
    const page = await browser.newPage();
    await page.route(ESPN_URL, proxyEspn);
    page.on("console", (msg) => {
      if (msg.type() === "error") console.error("[page]", msg.text());
    });
    // ?auto=1 keeps picks.js's old eager-load-every-league behavior; without
    // it picks.html now shows league tabs and loads nothing until clicked
    // (saves The Odds API quota for real visitors — see assets/js/picks.js).
    await page.goto("http://127.0.0.1:" + port + "/picks.html?auto=1", { waitUntil: "load" });
    await page.waitForFunction(() => window.__picksReady === true, null, { timeout: 90000 });
    sections = await page.evaluate(() => window.__picksSections);
    nbaCandidates = await page.evaluate(() => window.__picksNbaCandidates);
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

  const total = countPicks(trimmed);
  let upcomingNba = null;
  try {
    upcomingNba = await upcomingNbaGamesWithOdds();
  } catch (e) {
    console.error("[nba check] ESPN scoreboard failed: " + e.message);
  }
  const nbaFetchFailed = upcomingNba > 0 && !nbaCandidates;

  const date = taipeiToday();
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const file = path.join(OUT_DIR, date + ".json");

  // Never overwrite a day that already has picks: a re-run (manual
  // workflow_dispatch, or a delayed cron landing on the same Taiwan date)
  // would drop picks whose games have since started, reset results the
  // settle step already filled in, and effectively let picks be redrawn.
  if (fs.existsSync(file)) {
    let existing = null;
    try {
      existing = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch (e) {
      console.error("existing " + file + " is unreadable, overwriting: " + e.message);
    }
    if (existing && countPicks(existing.sections) > 0) {
      console.log(file + " already has " + countPicks(existing.sections) + " pick(s); leaving it untouched");
      if (nbaFetchFailed) throw new Error("NBA had " + upcomingNba + " upcoming game(s) with odds but picks.js produced no NBA candidate");
      return;
    }
  }

  fs.writeFileSync(file, JSON.stringify({
    date,
    recordedAt: new Date().toISOString(),
    sections: trimmed,
  }, null, 2));

  console.log("recorded " + total + " pick(s) across " + Object.keys(trimmed).length + " section(s) to " + file +
    " (NBA: " + nbaCandidates + " candidate(s), " + upcomingNba + " upcoming game(s) with odds)");
  // fail the job (after writing, so settle results still get committed) —
  // an empty file used to pass silently for 10 days while NBA was broken
  if (nbaFetchFailed) throw new Error("NBA had " + upcomingNba + " upcoming game(s) with odds but picks.js produced no NBA candidate");
})().catch((e) => {
  console.error("record-picks failed:", e);
  process.exit(1);
});
