#!/usr/bin/env node
/*
 * Settles pending picks recorded by scripts/record-picks.js against real
 * results, then rebuilds data/picks-stats.json (the rolling day/week/month
 * win-rate summary assets/js/picks.js fetches).
 *
 * Each league is checked against the same source picks.js itself used to
 * build the pick, so matching is an exact team-name string compare instead
 * of a fuzzy cross-API join:
 *   - MLB:        statsapi.mlb.com schedule (also gives first-inning runs for NRFI/YRFI)
 *   - NBA/WNBA:   ESPN scoreboard
 *   - KBO/NPB:    The Odds API /scores (no free score feed exists for these leagues)
 *
 * The Odds API keys are shared with the site's client-side odds fetching and
 * scripts/collect-odds.js (500 credits/month per key, 3 keys with automatic
 * fallback). This script calls /scores at most twice per run (once for KBO,
 * once for NPB, batched across every pending pick via daysFrom) regardless
 * of how many picks are pending — roughly 60 credits/month at a once-daily
 * cron, a small fixed slice of the shared budget.
 */
"use strict";

const fs = require("fs");
const path = require("path");

const HIST_DIR = path.join(__dirname, "..", "data", "picks-history");
const STATS_FILE = path.join(__dirname, "..", "data", "picks-stats.json");
const SETTLE_BUFFER_MS = 4 * 3600000;   // wait this long after start before checking a result
const VOID_AFTER_MS = 3 * 86400000;     // give up (mark void) if still unresolved after this long
const KEEP_MS = 35 * 86400000;          // prune history files older than this

const ODDS_API_KEYS = ["3fc688e03b27b3d41eb04f761c7f58c3", "78782417cf4202b1e74da436e45b3ecd", "7d1f6397f3aa8d041a767e5dcb440d97"];

const SECTION_META = {
  mlb_fi: "⚾ MLB 首局 NRFI / YRFI", mlb_ou: "⚾ MLB 大小分 Over/Under", mlb_sp: "⚾ MLB 讓分 Run Line",
  mlb_ml: "⚾ MLB 獨贏勝率", mlb_ml_edge: "⚾ MLB 獨贏優勢",
  wnba_ou: "🏀 WNBA 大小分 Over/Under", wnba_sp: "🏀 WNBA 讓分 Spread",
  nba_ml: "🏀 NBA 獨贏勝率",
  kbo_ml: "🇰🇷 KBO 獨贏勝率", kbo_ou: "🇰🇷 KBO 大小分 Over/Under", kbo_sp: "🇰🇷 KBO 讓分 Run Line",
  npb_ml: "🇯🇵 NPB 獨贏勝率", npb_ou: "🇯🇵 NPB 大小分 Over/Under", npb_sp: "🇯🇵 NPB 讓分 Run Line",
};

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

// mirrors scripts/collect-odds.js's fetchOddsApiWithFallback
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

function parseLine(pickText) {
  const m = /([+-]?\d+(?:\.\d+)?)\s*$/.exec(pickText || "");
  return m ? Number(m[1]) : null;
}

function settleMl(pick, awayScore, homeScore) {
  const pickedHome = / 主勝$/.test(pick.pick);
  if (homeScore === awayScore) return "push";
  const homeWon = homeScore > awayScore;
  return pickedHome === homeWon ? "win" : "loss";
}
function settleSpread(pick, awayScore, homeScore) {
  const pickedHome = pick.pick.indexOf(pick.home) === 0;
  const line = parseLine(pick.pick);
  if (line === null) return null;
  const margin = pickedHome ? homeScore - awayScore : awayScore - homeScore;
  const cover = margin + line;
  return cover > 0 ? "win" : cover < 0 ? "loss" : "push";
}
function settleTotal(pick, total) {
  const line = parseLine(pick.pick);
  if (line === null) return null;
  if (total === line) return "push";
  const over = total > line;
  return (pick.type === "over") === over ? "win" : "loss";
}
function settleFi(pick, inning1Total) {
  const scored = inning1Total > 0;
  return (pick.type === "yrfi") === scored ? "win" : "loss";
}

// ---------- MLB (statsapi) ----------
const mlbDateCache = new Map();
function mlbGameDate(iso) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(new Date(iso));
}
async function mlbGamesForDate(date) {
  if (mlbDateCache.has(date)) return mlbDateCache.get(date);
  const p = fetchJson("https://statsapi.mlb.com/api/v1/schedule?sportId=1&date=" + date + "&hydrate=linescore,team")
    .then((data) => {
      const map = new Map();
      (data.dates || []).forEach((d) => (d.games || []).forEach((g) => {
        if (!g.status || g.status.abstractGameState !== "Final") return;
        const away = g.teams.away.team.name, home = g.teams.home.team.name;
        const inn1 = g.linescore && g.linescore.innings && g.linescore.innings[0];
        map.set(away + "|" + home, {
          awayScore: Number(g.teams.away.score), homeScore: Number(g.teams.home.score),
          inning1Total: inn1 ? Number((inn1.away && inn1.away.runs) || 0) + Number((inn1.home && inn1.home.runs) || 0) : null,
        });
      }));
      return map;
    })
    .catch((e) => { console.error("[mlb] schedule fetch failed for " + date + ": " + e.message); return new Map(); });
  mlbDateCache.set(date, p);
  return p;
}
async function settleMlbPick(pick) {
  const map = await mlbGamesForDate(mlbGameDate(pick.start));
  const game = map.get(pick.away + "|" + pick.home);
  if (!game) return null;
  if (pick.type === "ml") return settleMl(pick, game.awayScore, game.homeScore);
  if (pick.type === "spread") return settleSpread(pick, game.awayScore, game.homeScore);
  if (pick.type === "over" || pick.type === "under") return settleTotal(pick, game.awayScore + game.homeScore);
  if (pick.type === "nrfi" || pick.type === "yrfi") {
    if (game.inning1Total === null) return null;
    return settleFi(pick, game.inning1Total);
  }
  return null;
}

// ---------- NBA / WNBA (ESPN scoreboard) ----------
const espnDateCache = new Map();
function espnGameDate(iso) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(new Date(iso)).replace(/-/g, "");
}
async function espnGamesForDate(leagueKey, date) {
  const cacheKey = leagueKey + ":" + date;
  if (espnDateCache.has(cacheKey)) return espnDateCache.get(cacheKey);
  const p = fetchJson("https://site.api.espn.com/apis/site/v2/sports/basketball/" + leagueKey + "/scoreboard?dates=" + date)
    .then((data) => {
      const map = new Map();
      (data.events || []).forEach((ev) => {
        const comp = ev.competitions && ev.competitions[0];
        if (!comp || !comp.status || !comp.status.type || comp.status.type.state !== "post") return;
        const home = comp.competitors.find((c) => c.homeAway === "home");
        const away = comp.competitors.find((c) => c.homeAway === "away");
        if (!home || !away) return;
        map.set(away.team.displayName + "|" + home.team.displayName, {
          awayScore: Number(away.score), homeScore: Number(home.score),
        });
      });
      return map;
    })
    .catch((e) => { console.error("[" + leagueKey + "] scoreboard fetch failed for " + date + ": " + e.message); return new Map(); });
  espnDateCache.set(cacheKey, p);
  return p;
}
async function settleEspnPick(leagueKey, pick) {
  const map = await espnGamesForDate(leagueKey, espnGameDate(pick.start));
  const game = map.get(pick.away + "|" + pick.home);
  if (!game) return null;
  if (pick.type === "ml") return settleMl(pick, game.awayScore, game.homeScore);
  if (pick.type === "spread") return settleSpread(pick, game.awayScore, game.homeScore);
  if (pick.type === "over" || pick.type === "under") return settleTotal(pick, game.awayScore + game.homeScore);
  return null;
}

// ---------- KBO / NPB (The Odds API /scores) ----------
const oddsApiScoresCache = new Map();
async function oddsApiScores(sportKey) {
  if (oddsApiScoresCache.has(sportKey)) return oddsApiScoresCache.get(sportKey);
  const p = fetchOddsApiWithFallback((key) =>
    "https://api.the-odds-api.com/v4/sports/" + sportKey + "/scores/?apiKey=" + key + "&daysFrom=3"
  ).then((data) => {
    const map = new Map();
    (data || []).forEach((ev) => {
      if (!ev.completed || !ev.scores) return;
      const homeScore = ev.scores.find((s) => s.name === ev.home_team);
      const awayScore = ev.scores.find((s) => s.name === ev.away_team);
      if (!homeScore || !awayScore) return;
      map.set(ev.away_team + "|" + ev.home_team, {
        awayScore: Number(awayScore.score), homeScore: Number(homeScore.score),
      });
    });
    return map;
  }).catch((e) => { console.error("[" + sportKey + "] /scores fetch failed: " + e.message); return new Map(); });
  oddsApiScoresCache.set(sportKey, p);
  return p;
}
async function settleOddsApiPick(sportKey, pick) {
  const map = await oddsApiScores(sportKey);
  const game = map.get(pick.away + "|" + pick.home);
  if (!game) return null;
  if (pick.type === "ml") return settleMl(pick, game.awayScore, game.homeScore);
  if (pick.type === "spread") return settleSpread(pick, game.awayScore, game.homeScore);
  if (pick.type === "over" || pick.type === "under") return settleTotal(pick, game.awayScore + game.homeScore);
  return null;
}

async function settlePick(sectionKey, pick) {
  if (sectionKey.indexOf("mlb_") === 0) return settleMlbPick(pick);
  if (sectionKey.indexOf("nba_") === 0) return settleEspnPick("nba", pick);
  if (sectionKey.indexOf("wnba_") === 0) return settleEspnPick("wnba", pick);
  if (sectionKey.indexOf("kbo_") === 0) return settleOddsApiPick("baseball_kbo", pick);
  if (sectionKey.indexOf("npb_") === 0) return settleOddsApiPick("baseball_npb", pick);
  return null;
}

// ---------- main ----------
function loadHistoryFiles() {
  fs.mkdirSync(HIST_DIR, { recursive: true });
  return fs.readdirSync(HIST_DIR)
    .filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))
    .sort();
}

async function settleAll() {
  const now = Date.now();
  const files = loadHistoryFiles();
  let settledCount = 0, voidCount = 0;

  for (const fname of files) {
    const fpath = path.join(HIST_DIR, fname);
    let doc;
    try {
      doc = JSON.parse(fs.readFileSync(fpath, "utf8"));
    } catch (e) {
      console.error("skipping unreadable " + fname + ": " + e.message);
      continue;
    }
    let dirty = false;

    for (const sectionKey of Object.keys(doc.sections || {})) {
      for (const pick of doc.sections[sectionKey]) {
        if (pick.result !== null) continue;
        const startMs = new Date(pick.start).getTime();
        if (!isFinite(startMs) || now - startMs < SETTLE_BUFFER_MS) continue;

        let result = null;
        try {
          result = await settlePick(sectionKey, pick);
        } catch (e) {
          console.error("settle failed for " + sectionKey + " " + pick.away + "@" + pick.home + ": " + e.message);
        }

        if (result) {
          pick.result = result;
          dirty = true;
          settledCount++;
        } else if (now - startMs > VOID_AFTER_MS) {
          pick.result = "void";
          dirty = true;
          voidCount++;
        }
      }
    }

    if (dirty) fs.writeFileSync(fpath, JSON.stringify(doc, null, 2));
  }

  console.log("settled " + settledCount + " pick(s), voided " + voidCount + " pick(s)");

  // prune history files older than KEEP_MS
  for (const fname of files) {
    const d = new Date(fname.replace(".json", "")).getTime();
    if (isFinite(d) && now - d > KEEP_MS) {
      fs.unlinkSync(path.join(HIST_DIR, fname));
      console.log("pruned " + fname);
    }
  }
}

function rebuildStats() {
  const files = loadHistoryFiles();
  const now = new Date();
  const monthCutoff = new Date(now.getTime() - 30 * 86400000);
  const weekCutoff = new Date(now.getTime() - 7 * 86400000);

  // per section: rolling week/month win-loss totals, plus the most recent
  // settled date's own tally for the "day" bucket
  const week = {}, month = {}, dayBucket = {};
  for (const key of Object.keys(SECTION_META)) {
    week[key] = { from: null, to: null, w: 0, l: 0 };
    month[key] = { from: null, to: null, w: 0, l: 0 };
  }

  for (const fname of files) {
    const date = fname.replace(".json", "");
    if (new Date(date) < monthCutoff) continue;
    let doc;
    try {
      doc = JSON.parse(fs.readFileSync(path.join(HIST_DIR, fname), "utf8"));
    } catch (e) { continue; }

    const inWeek = new Date(date) >= weekCutoff;
    for (const key of Object.keys(doc.sections || {})) {
      if (!month[key]) continue;
      const settled = doc.sections[key].filter((p) => p.result === "win" || p.result === "loss");
      if (!settled.length) continue;
      const w = settled.filter((p) => p.result === "win").length;
      const l = settled.length - w;

      month[key].w += w; month[key].l += l;
      if (!month[key].from || date < month[key].from) month[key].from = date;
      month[key].to = date;

      if (inWeek) {
        week[key].w += w; week[key].l += l;
        if (!week[key].from || date < week[key].from) week[key].from = date;
        week[key].to = date;
      }

      // most recent settled date (within the month window) becomes the "day" bucket
      if (!dayBucket[key] || date > dayBucket[key].date) dayBucket[key] = { date, w, l };
    }
  }

  const out = { updated: new Date().toISOString(), sections: {} };
  for (const key of Object.keys(SECTION_META)) {
    out.sections[key] = {
      label: SECTION_META[key],
      day: dayBucket[key] || null,
      week: week[key].to ? week[key] : null,
      month: month[key].to ? month[key] : null,
    };
  }
  fs.mkdirSync(path.dirname(STATS_FILE), { recursive: true });
  fs.writeFileSync(STATS_FILE, JSON.stringify(out, null, 2));
  console.log("rebuilt " + STATS_FILE);
}

(async () => {
  await settleAll();
  rebuildStats();
})().catch((e) => {
  console.error("settle-picks failed:", e);
  process.exit(1);
});
