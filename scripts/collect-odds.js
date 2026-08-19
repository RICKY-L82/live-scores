#!/usr/bin/env node
/*
 * Collect ESPN odds snapshots for MLB / NBA / WNBA into data/odds/<league>.json.
 * Runs on a schedule via GitHub Actions; appends a snapshot per game only
 * when the odds changed since the last recorded snapshot.
 *
 * File format:
 * {
 *   "updated": "2026-07-09T05:00:00.000Z",
 *   "events": {
 *     "<espnEventId>": {
 *       "key": "Away Display Name|Home Display Name",
 *       "date": "2026-07-09T17:05:00Z",       // game start (ISO, from ESPN)
 *       "snaps": [
 *         { "t": 1720500000000,
 *           "mlA": "-135", "mlH": "+115",
 *           "spA": "-1.5", "spAO": "-110", "spH": "+1.5", "spHO": "-110",
 *           "tot": "8.5", "oO": "-105", "uO": "-115" }
 *       ]
 *     }
 *   }
 * }
 */
"use strict";

const fs = require("fs");
const path = require("path");

const LEAGUES = {
  mlb: "baseball/mlb",
  // nba: "basketball/nba", // temporarily disabled — NBA off-season, will re-enable later
  wnba: "basketball/wnba",
};
const OUT_DIR = path.join(__dirname, "..", "data", "odds");
const KEEP_MS = 4 * 86400000; // drop events older than 4 days
const MAX_SNAPS = 300;        // hard cap per event

// KBO/NPB have no ESPN odds feed, so their snapshots come from The Odds API
// instead — but that's a metered, shared key (also used by assets/js/picks.js
// client-side for KBO/NPB picks and MLB NRFI), while this script runs on a
// 20-minute cron whether or not anyone is visiting the site. Fetching on
// every run would burn the whole monthly quota in about a day, so each
// league is throttled to once per ODDS_API_MIN_INTERVAL_MS regardless of how
// often this script itself runs, and only the h2h market is requested (the
// cheapest one — 1 credit/call vs 3 for h2h+spreads+totals) since a 讓分/
// 大小分走勢 signal isn't worth risking the shared quota for.
// same two keys assets/js/picks.js falls back between; already public in client JS
const ODDS_API_KEYS = ["3fc688e03b27b3d41eb04f761c7f58c3", "78782417cf4202b1e74da436e45b3ecd"];
const ODDS_API_LEAGUES = { kbo: "baseball_kbo", npb: "baseball_npb" };
const ODDS_API_MIN_INTERVAL_MS = 4 * 3600000; // 4h → ~360 credits/month for these two leagues combined

// tries each key in turn, only moving to the next on a quota/auth failure
// (401/429) — a different kind of error (network blip, 5xx) shouldn't burn
// through the fallback key too
async function fetchOddsApiWithFallback(urlForKey) {
  let lastErr;
  for (const key of ODDS_API_KEYS) {
    try {
      return await fetchJson(urlForKey(key));
    } catch (e) {
      lastErr = e;
      if (!/HTTP (401|429)/.test(String((e && e.message) || ""))) throw e;
    }
  }
  throw lastErr;
}

function espnDate(offsetDays) {
  // ESPN scoreboard dates follow US Eastern time
  const d = new Date(Date.now() + offsetDays * 86400000);
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric", month: "2-digit", day: "2-digit",
  }).format(d).replace(/-/g, "");
}

async function fetchJson(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20000);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error("HTTP " + res.status + " for " + url);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

// mirrors extractEspnOdds() in assets/js/app.js, flattened for storage
function snapFromOdds(oddsArr) {
  if (!oddsArr || !oddsArr.length) return null;
  const o = oddsArr.find((x) => x.moneyline || x.pointSpread || x.total) || oddsArr[0];
  const snap = {};

  const close = (m, s) => {
    const x = m && m[s];
    return x && x.close ? x.close : null;
  };

  if (o.moneyline) {
    const a = close(o.moneyline, "away");
    const h = close(o.moneyline, "home");
    if (a && a.odds) snap.mlA = a.odds;
    if (h && h.odds) snap.mlH = h.odds;
  } else if (o.awayTeamOdds && o.awayTeamOdds.moneyLine !== undefined) {
    snap.mlA = String(o.awayTeamOdds.moneyLine);
    if (o.homeTeamOdds && o.homeTeamOdds.moneyLine !== undefined) {
      snap.mlH = String(o.homeTeamOdds.moneyLine);
    }
  }
  if (o.pointSpread) {
    const a = close(o.pointSpread, "away");
    const h = close(o.pointSpread, "home");
    if (a) { if (a.line) snap.spA = a.line; if (a.odds) snap.spAO = a.odds; }
    if (h) { if (h.line) snap.spH = h.line; if (h.odds) snap.spHO = h.odds; }
  }
  if (o.total) {
    const ov = close(o.total, "over");
    const un = close(o.total, "under");
    if (ov) {
      if (ov.line) snap.tot = String(ov.line).replace(/^[ou]/i, "");
      if (ov.odds) snap.oO = ov.odds;
    }
    if (un && un.odds) snap.uO = un.odds;
  } else if (o.overUnder !== undefined && o.overUnder !== null) {
    snap.tot = String(o.overUnder);
  }

  return Object.keys(snap).length ? snap : null;
}

function snapSig(snap) {
  const { t, ...rest } = snap;
  return JSON.stringify(rest, Object.keys(rest).sort());
}

function loadHistory(league) {
  const file = path.join(OUT_DIR, league + ".json");
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    return { updated: null, events: {} };
  }
}

async function collectLeague(league, slug) {
  const hist = loadHistory(league);
  const now = Date.now();
  let added = 0;

  // today + tomorrow (US Eastern) so opening lines for tomorrow are captured
  for (const dates of [espnDate(0), espnDate(1)]) {
    let data;
    try {
      data = await fetchJson(
        "https://site.api.espn.com/apis/site/v2/sports/" + slug + "/scoreboard?dates=" + dates
      );
    } catch (e) {
      console.error("[" + league + "] fetch failed for " + dates + ": " + e.message);
      continue;
    }
    for (const ev of data.events || []) {
      const comp = ev.competitions && ev.competitions[0];
      if (!comp) continue;
      const snap = snapFromOdds(comp.odds);
      if (!snap) continue;
      const home = (comp.competitors || []).find((c) => c.homeAway === "home");
      const away = (comp.competitors || []).find((c) => c.homeAway === "away");
      if (!home || !away) continue;

      let entry = hist.events[ev.id];
      if (!entry) {
        entry = hist.events[ev.id] = {
          key: away.team.displayName + "|" + home.team.displayName,
          date: ev.date,
          snaps: [],
        };
      }
      snap.t = now;
      const last = entry.snaps[entry.snaps.length - 1];
      if (!last || snapSig(last) !== snapSig(snap)) {
        entry.snaps.push(snap);
        if (entry.snaps.length > MAX_SNAPS) entry.snaps = entry.snaps.slice(-MAX_SNAPS);
        added++;
      }
    }
  }

  // prune stale events
  for (const id of Object.keys(hist.events)) {
    const d = new Date(hist.events[id].date).getTime();
    if (!isFinite(d) || d < now - KEEP_MS) delete hist.events[id];
  }

  hist.updated = new Date(now).toISOString();
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUT_DIR, league + ".json"), JSON.stringify(hist));
  console.log("[" + league + "] " + added + " new snapshot(s), " +
    Object.keys(hist.events).length + " event(s) tracked");
  return added;
}

// mirrors snapFromOdds() above but for The Odds API's response shape
// (bookmakers[].markets[].outcomes[]) instead of ESPN's; only ever looks at
// h2h since that's the only market requested for KBO/NPB
function snapFromOddsApiEvent(ev) {
  for (const bk of ev.bookmakers || []) {
    const mk = (bk.markets || []).find((m) => m.key === "h2h");
    if (!mk) continue;
    const home = (mk.outcomes || []).find((o) => o.name === ev.home_team);
    const away = (mk.outcomes || []).find((o) => o.name === ev.away_team);
    if (home && away && home.price !== undefined && away.price !== undefined) {
      return { mlA: String(away.price), mlH: String(home.price) };
    }
  }
  return null;
}

async function collectOddsApiLeague(league, sportKey) {
  const hist = loadHistory(league);
  const now = Date.now();
  const lastMs = hist.updated ? new Date(hist.updated).getTime() : 0;
  if (isFinite(lastMs) && now - lastMs < ODDS_API_MIN_INTERVAL_MS) {
    console.log("[" + league + "] skipped (throttled, last checked " + hist.updated + ")");
    return 0;
  }

  let data;
  try {
    data = await fetchOddsApiWithFallback((key) =>
      "https://api.the-odds-api.com/v4/sports/" + sportKey +
      "/odds?apiKey=" + key + "&regions=us&markets=h2h&oddsFormat=american"
    );
  } catch (e) {
    console.error("[" + league + "] fetch failed: " + e.message);
    return 0; // don't bump hist.updated on failure — retry on the next cron tick instead of waiting a full interval
  }

  let added = 0;
  for (const ev of data || []) {
    const snap = snapFromOddsApiEvent(ev);
    if (!snap) continue;
    let entry = hist.events[ev.id];
    if (!entry) {
      entry = hist.events[ev.id] = { key: ev.away_team + "|" + ev.home_team, date: ev.commence_time, snaps: [] };
    }
    snap.t = now;
    const last = entry.snaps[entry.snaps.length - 1];
    if (!last || snapSig(last) !== snapSig(snap)) {
      entry.snaps.push(snap);
      if (entry.snaps.length > MAX_SNAPS) entry.snaps = entry.snaps.slice(-MAX_SNAPS);
      added++;
    }
  }

  for (const id of Object.keys(hist.events)) {
    const d = new Date(hist.events[id].date).getTime();
    if (!isFinite(d) || d < now - KEEP_MS) delete hist.events[id];
  }

  hist.updated = new Date(now).toISOString();
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUT_DIR, league + ".json"), JSON.stringify(hist));
  console.log("[" + league + "] " + added + " new snapshot(s), " +
    Object.keys(hist.events).length + " event(s) tracked");
  return added;
}

(async () => {
  let failures = 0;
  for (const [league, slug] of Object.entries(LEAGUES)) {
    try {
      await collectLeague(league, slug);
    } catch (e) {
      failures++;
      console.error("[" + league + "] collection failed: " + (e && e.message));
    }
  }
  for (const [league, sportKey] of Object.entries(ODDS_API_LEAGUES)) {
    try {
      await collectOddsApiLeague(league, sportKey);
    } catch (e) {
      failures++;
      console.error("[" + league + "] collection failed: " + (e && e.message));
    }
  }
  // fail the job only if every league failed
  if (failures === Object.keys(LEAGUES).length + Object.keys(ODDS_API_LEAGUES).length) process.exit(1);
})();
