#!/usr/bin/env node
/*
 * Builds data/nba/stats.json for assets/js/picks.js's NBA model:
 *   - teams[id]: pace / offensive & defensive rating (possession-based, from
 *     ESPN team statistics + standings), first-half share of regulation
 *     points (from quarter linescores), and recent game dates (rest / 背靠背)
 *   - players[id]: points & minutes per game, joined client-side against the
 *     live ESPN injury report to size each absence
 * Early in a season every rating is blended with last regular season's,
 * weighted by games played, so the model works from opening night on.
 *
 * data/nba/games.json is this script's own store of finished games
 * (quarter scores), backfilled for last season on first run and then
 * topped up from the last few days' scoreboards. Only free ESPN endpoints
 * are used; the whole run is throttled to once per MIN_INTERVAL_MS.
 */
"use strict";

const fs = require("fs");
const path = require("path");

const DIR = path.join(__dirname, "..", "data", "nba");
const STATS_FILE = path.join(DIR, "stats.json");
const GAMES_FILE = path.join(DIR, "games.json");
const MIN_INTERVAL_MS = 3 * 3600000;
const SITE = "https://site.api.espn.com/apis/site/v2/sports/basketball/nba";
const BLEND_GP = 15;  // current season gets weight gp/(gp+BLEND_GP) vs last season
const PREV_H1_WEIGHT = 0.5;

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
function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch (e) { return fallback; }
}
function etDate(d) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(d);
}
// ESPN labels 2026-27 as season 2027
function currentSeason(now) {
  const d = new Date(now);
  return d.getUTCMonth() >= 7 ? d.getUTCFullYear() + 1 : d.getUTCFullYear();
}

// ---------- finished games (quarter scores) ----------
async function gamesForDate(ymd) {
  const data = await fetchJson(SITE + "/scoreboard?dates=" + ymd.replace(/-/g, ""));
  const out = [];
  for (const ev of data.events || []) {
    const comp = ev.competitions && ev.competitions[0];
    if (!comp || !comp.status || !comp.status.type || comp.status.type.state !== "post") continue;
    const seasonType = ev.season && ev.season.type;
    if (seasonType !== 2 && seasonType !== 3) continue; // regular season + playoffs only
    const home = comp.competitors.find((c) => c.homeAway === "home");
    const away = comp.competitors.find((c) => c.homeAway === "away");
    if (!home || !away) continue;
    const q = (c) => (c.linescores || []).map((l) => Number(l.value));
    const aq = q(away), hq = q(home);
    if (aq.length < 4 || hq.length < 4) continue;
    out.push({
      id: ev.id, date: ev.date, season: ev.season.year,
      away: away.team.id, home: home.team.id, aq, hq,
    });
  }
  return out;
}
async function topUpGames(store, dates) {
  let added = 0;
  for (const ymd of dates) {
    let games;
    try { games = await gamesForDate(ymd); } catch (e) { console.error("[nba-stats] scoreboard " + ymd + ": " + e.message); continue; }
    for (const g of games) {
      if (!store.games[g.id]) added++;
      store.games[g.id] = g;
    }
  }
  return added;
}
function dateRange(fromYmd, toYmd) {
  const out = [];
  for (let t = Date.parse(fromYmd + "T12:00:00Z"); t <= Date.parse(toYmd + "T12:00:00Z"); t += 86400000) {
    out.push(new Date(t).toISOString().slice(0, 10));
  }
  return out;
}

// ---------- team ratings ----------
function statMap(categories) {
  const m = {};
  (categories || []).forEach((c) => (c.stats || []).forEach((s) => { m[s.name] = Number(s.value); }));
  return m;
}
async function standingsAgainst(season) {
  const d = await fetchJson("https://site.api.espn.com/apis/v2/sports/basketball/nba/standings?level=3&season=" + season + "&seasontype=2");
  const map = {};
  (function walk(node) {
    ((node.standings && node.standings.entries) || []).forEach((e) => {
      const s = {};
      (e.stats || []).forEach((x) => { s[x.name] = Number(x.value); });
      map[e.team.id] = { pa: s.avgPointsAgainst, gp: (s.wins || 0) + (s.losses || 0) };
    });
    (node.children || []).forEach(walk);
  })(d);
  return map;
}
async function teamRatings(season, teamIds) {
  let against = {};
  try { against = await standingsAgainst(season); } catch (e) { console.error("[nba-stats] standings " + season + ": " + e.message); }
  const out = {};
  for (const id of teamIds) {
    let st;
    try {
      st = await fetchJson(SITE + "/teams/" + id + "/statistics?season=" + season + "&seasontype=2");
    } catch (e) { continue; }
    // ESPN answers an unplayed season with the last completed one instead
    if (!st.requestedSeason || st.requestedSeason.year !== season || st.requestedSeason.type !== 2) continue;
    const m = statMap(st.results && st.results.stats && st.results.stats.categories);
    const gp = m.gamesPlayed;
    const poss = m.avgFieldGoalsAttempted - m.avgOffensiveRebounds + m.avgTurnovers + 0.44 * m.avgFreeThrowsAttempted;
    const pa = against[id] && against[id].pa;
    if (!(gp > 0) || !(poss > 0) || !isFinite(m.avgPoints) || !isFinite(pa)) continue;
    out[id] = { gp, pace: poss, ortg: m.avgPoints / poss * 100, drtg: pa / poss * 100 };
  }
  return out;
}
function blend(cur, prev) {
  if (!cur && !prev) return null;
  if (!prev) return cur;
  if (!cur) return Object.assign({}, prev, { gp: 0, prevGp: prev.gp });
  const w = cur.gp / (cur.gp + BLEND_GP);
  const mix = (k) => w * cur[k] + (1 - w) * prev[k];
  return { gp: cur.gp, prevGp: prev.gp, pace: mix("pace"), ortg: mix("ortg"), drtg: mix("drtg") };
}

// ---------- players ----------
async function playerStats(season) {
  const url = "https://site.web.api.espn.com/apis/common/v3/sports/basketball/nba/statistics/byathlete" +
    "?region=us&lang=en&contentorigin=espn&isqualified=false&page=1&limit=350" +
    "&sort=offensive.avgPoints%3Adesc&season=" + season + "&seasontype=2";
  const d = await fetchJson(url);
  if (!d.athletes) return {};
  const idx = {};
  (d.categories || []).forEach((c, ci) => (c.names || []).forEach((n, ni) => { idx[c.name + "." + n] = [ci, ni]; }));
  const val = (a, key) => {
    const p = idx[key];
    const cat = p && a.categories.find((c) => c.name === d.categories[p[0]].name);
    return cat ? Number(cat.values[p[1]]) : NaN;
  };
  const out = {};
  d.athletes.forEach((a) => {
    const gp = val(a, "general.gamesPlayed"), mpg = val(a, "general.avgMinutes"), ppg = val(a, "offensive.avgPoints");
    if (!(gp > 0) || !isFinite(ppg)) return;
    out[a.athlete.id] = { n: a.athlete.displayName, s: season, gp, mpg: Math.round(mpg * 10) / 10, ppg: Math.round(ppg * 10) / 10 };
  });
  return out;
}

(async () => {
  const now = Date.now();
  const prevStats = readJson(STATS_FILE, null);
  const force = process.argv.includes("--force");
  if (!force && prevStats && prevStats.updated && now - Date.parse(prevStats.updated) < MIN_INTERVAL_MS) {
    console.log("[nba-stats] skipped (throttled, last built " + prevStats.updated + ")");
    return;
  }
  const season = currentSeason(now), lastSeason = season - 1;
  const store = readJson(GAMES_FILE, { backfilled: {}, games: {} });
  store.backfilled = store.backfilled || {};

  // one-time backfill of last regular season + playoffs
  if (!store.backfilled[lastSeason]) {
    const from = (lastSeason - 1) + "-10-15", to = lastSeason + "-06-25";
    const n = await topUpGames(store, dateRange(from, to));
    store.backfilled[lastSeason] = true;
    console.log("[nba-stats] backfilled season " + lastSeason + ": " + n + " game(s)");
  }
  const today = etDate(new Date(now));
  const recent = dateRange(etDate(new Date(now - 4 * 86400000)), today);
  const added = await topUpGames(store, recent);
  for (const id of Object.keys(store.games)) {
    if (store.games[id].season < lastSeason) delete store.games[id];
  }

  const teamList = await fetchJson(SITE + "/teams");
  const teamIds = teamList.sports[0].leagues[0].teams.map((t) => t.team.id);
  const names = {};
  teamList.sports[0].leagues[0].teams.forEach((t) => { names[t.team.id] = t.team.displayName; });

  // last season's ratings never change once it's over — compute once and keep
  let prevRatings = prevStats && prevStats.prevSeason === lastSeason && prevStats.prevRatings;
  if (!prevRatings || !Object.keys(prevRatings).length) prevRatings = await teamRatings(lastSeason, teamIds);
  const curRatings = await teamRatings(season, teamIds);

  // first-half share of regulation points, per team, current + discounted last season
  const h1 = {};
  let lgH1 = 0, lgReg = 0;
  Object.values(store.games).forEach((g) => {
    const w = g.season === season ? 1 : PREV_H1_WEIGHT;
    const h1pts = g.aq[0] + g.aq[1] + g.hq[0] + g.hq[1];
    const reg = h1pts + g.aq[2] + g.aq[3] + g.hq[2] + g.hq[3];
    [g.away, g.home].forEach((t) => {
      const r = h1[t] || (h1[t] = { h1: 0, reg: 0, n: 0 });
      r.h1 += w * h1pts; r.reg += w * reg; r.n += w;
    });
    lgH1 += w * h1pts; lgReg += w * reg;
  });
  const lgShare = lgReg ? lgH1 / lgReg : 0.507;

  // most recent game dates per team (for rest days), current season only
  const lastGames = {};
  Object.values(store.games)
    .filter((g) => g.season === season)
    .sort((a, b) => Date.parse(b.date) - Date.parse(a.date))
    .forEach((g) => [g.away, g.home].forEach((t) => {
      const arr = lastGames[t] || (lastGames[t] = []);
      if (arr.length < 3) arr.push(g.date);
    }));

  const teams = {};
  teamIds.forEach((id) => {
    const r = blend(curRatings[id], prevRatings[id]);
    const s = h1[id];
    teams[id] = {
      name: names[id],
      gp: r ? r.gp : 0, prevGp: r ? r.prevGp || 0 : 0,
      pace: r ? +r.pace.toFixed(2) : null,
      ortg: r ? +r.ortg.toFixed(2) : null,
      drtg: r ? +r.drtg.toFixed(2) : null,
      h1Share: s && s.reg ? +(s.h1 / s.reg).toFixed(4) : null,
      h1Games: s ? Math.round(s.n) : 0,
      lastGames: lastGames[id] || [],
    };
  });
  const rated = teamIds.map((id) => teams[id]).filter((t) => t.pace);
  const avg = (k) => rated.reduce((x, t) => x + t[k], 0) / (rated.length || 1);

  let curPlayers = {}, prevPlayers = (prevStats && prevStats.prevSeason === lastSeason && prevStats.prevPlayers) || null;
  try { curPlayers = await playerStats(season); } catch (e) { console.error("[nba-stats] players " + season + ": " + e.message); }
  if (!prevPlayers) {
    try { prevPlayers = await playerStats(lastSeason); } catch (e) { prevPlayers = {}; console.error("[nba-stats] players " + lastSeason + ": " + e.message); }
  }
  const players = Object.assign({}, prevPlayers);
  Object.keys(curPlayers).forEach((id) => { if (curPlayers[id].gp >= 5 || !players[id]) players[id] = curPlayers[id]; });

  const out = {
    updated: new Date(now).toISOString(),
    season, prevSeason: lastSeason,
    league: { pace: +avg("pace").toFixed(2), ortg: +avg("ortg").toFixed(2), h1Share: +lgShare.toFixed(4) },
    teams, players,
    prevRatings, prevPlayers,
  };
  fs.mkdirSync(DIR, { recursive: true });
  fs.writeFileSync(GAMES_FILE, JSON.stringify(store));
  fs.writeFileSync(STATS_FILE, JSON.stringify(out));
  console.log("[nba-stats] " + added + " new game(s); " + Object.keys(store.games).length + " stored; " +
    rated.length + " team(s) rated (current season: " + Object.keys(curRatings).length + "); " +
    Object.keys(players).length + " player(s); league h1 share " + lgShare.toFixed(4));
})().catch((e) => { console.error("[nba-stats] failed: " + (e && e.message)); process.exit(1); });
