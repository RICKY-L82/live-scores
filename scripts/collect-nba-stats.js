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
 *   - upcoming[eventId]: schedule-fatigue features (rest, 背靠背, 4 天 3 戰,
 *     travel distance, time zones crossed, altitude) for the next two days
 *   - calib: coefficients fitted by nba-model-lib.js's backtest, plus
 *     calib.deployed: market weights fitted on data/nba/proj-log.json
 *   - trends[id]: this season's record against the DraftKings closing
 *     spread (過盤) and total (大小分), from data/nba/games.json
 *
 * data/nba/games.json is this script's own store of finished games
 * (quarter scores + DraftKings closing spread/total from ESPN's game
 * summary), backfilled for last season on first run and then topped up
 * from the last few days' scoreboards. Only free ESPN endpoints are used;
 * the whole run is throttled to once per MIN_INTERVAL_MS.
 *
 * data/nba/proj-log.json keeps, per game, the last pre-game projection of
 * the model picks.js runs (nba-model-lib.js projectGame, with the live
 * injury report and ESPN predictor), rewritten every run until tip-off.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const { ARENAS, fatigue, calibrate, projectGame, calibrateDeployed } = require("./nba-model-lib");

const DIR = path.join(__dirname, "..", "data", "nba");
const STATS_FILE = path.join(DIR, "stats.json");
const GAMES_FILE = path.join(DIR, "games.json");
const PROJ_LOG_FILE = path.join(DIR, "proj-log.json");
const PROJ_LOG_KEEP_MS = 400 * 86400000;
const MIN_INTERVAL_MS = 3 * 3600000;
const SITE = "https://site.api.espn.com/apis/site/v2/sports/basketball/nba";
const BLEND_GP = 15;  // current season gets weight gp/(gp+BLEND_GP) vs last season
const PACE_BLEND_GP = 5;  // pace settles within a few games, so it leans on this season sooner
const PREV_H1_WEIGHT = 0.5;
const PLAYERS_VERSION = 2;  // bump when the per-player fields change
const LINE_TRIES = 2;
const BACKFILL_MIN_GAMES = 1000;  // last season counts as backfilled once this many of its games are stored
const RECENT_N = 10;

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
// DraftKings closing line from ESPN's game summary; hl = home spread,
// ml = [away, home] moneyline (null when not posted)
async function fetchLines(g) {
  const s = await fetchJson(SITE + "/summary?event=" + g.id);
  const pc = (s.pickcenter || []).find((p) => isFinite(Number(p.spread)) && isFinite(Number(p.overUnder)));
  if (!pc) return null;
  let hl = Number(pc.spread);
  const m = /^(\S+)\s+([+-]?\d+(?:\.\d+)?)$/.exec(String(pc.details || "").trim());
  const comp = s.header && s.header.competitions && s.header.competitions[0];
  const home = comp && comp.competitors.find((c) => c.homeAway === "home");
  if (m && home && home.team) hl = m[1] === home.team.abbreviation ? Number(m[2]) : -Number(m[2]);
  const mlA = pc.awayTeamOdds && Number(pc.awayTeamOdds.moneyLine), mlH = pc.homeTeamOdds && Number(pc.homeTeamOdds.moneyLine);
  return { hl, tot: Number(pc.overUnder), ml: isFinite(mlA) && isFinite(mlH) && mlA && mlH ? [mlA, mlH] : null };
}
// also revisits this season's games stored before ln.ml existed
async function fillLines(store, season) {
  const needsMl = (g) => g.season === season && g.ln && g.ln.ml === undefined && (g.mlTries || 0) < LINE_TRIES;
  const todo = Object.values(store.games).filter((g) => (!g.ln && (g.lnTries || 0) < LINE_TRIES) || needsMl(g));
  let filled = 0, i = 0;
  async function worker() {
    while (i < todo.length) {
      const g = todo[i++];
      const mlOnly = !!g.ln;
      if (mlOnly) g.mlTries = (g.mlTries || 0) + 1;
      else g.lnTries = (g.lnTries || 0) + 1;
      try {
        const ln = await fetchLines(g);
        if (ln && mlOnly) { if (ln.ml || g.mlTries >= LINE_TRIES) g.ln.ml = ln.ml; }
        else if (ln) { g.ln = ln; filled++; }
      } catch (e) { /* retried next run, up to LINE_TRIES */ }
    }
  }
  await Promise.all(Array.from({ length: 8 }, worker));
  return { tried: todo.length, filled };
}
async function topUpGames(store, dates) {
  let added = 0;
  for (const ymd of dates) {
    let games;
    try { games = await gamesForDate(ymd); } catch (e) { console.error("[nba-stats] scoreboard " + ymd + ": " + e.message); continue; }
    for (const g of games) {
      if (!store.games[g.id]) { added++; store.games[g.id] = g; }
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
  const w = cur.gp / (cur.gp + BLEND_GP), wp = cur.gp / (cur.gp + PACE_BLEND_GP);
  const mix = (k) => w * cur[k] + (1 - w) * prev[k];
  return {
    gp: cur.gp, prevGp: prev.gp, pace: wp * cur.pace + (1 - wp) * prev.pace, paceCur: cur.pace,
    ortg: mix("ortg"), drtg: mix("drtg"),
  };
}

// this season's results against the closing line, per team: spread from
// the team's side (w/l/p) and the game total (o/u/p); overtime counts, as
// it does for the book
function lineTrends(games, season) {
  const out = {};
  Object.values(games).forEach((g) => {
    if (g.season !== season || !g.ln || !isFinite(g.ln.hl) || !isFinite(g.ln.tot)) return;
    const aPts = g.aq.reduce((x, y) => x + y, 0), hPts = g.hq.reduce((x, y) => x + y, 0);
    const homeAts = Math.sign(hPts - aPts + g.ln.hl), ou = Math.sign(aPts + hPts - g.ln.tot);
    [[g.home, homeAts], [g.away, -homeAts]].forEach(([t, ats]) => {
      const r = out[t] || (out[t] = { n: 0, w: 0, l: 0, p: 0, o: 0, u: 0, op: 0, pts: 0, line: 0 });
      r.n++;
      r[ats > 0 ? "w" : ats < 0 ? "l" : "p"]++;
      r[ou > 0 ? "o" : ou < 0 ? "u" : "op"]++;
      r.pts += aPts + hPts; r.line += g.ln.tot;
    });
  });
  Object.values(out).forEach((r) => {
    r.pts = +(r.pts / r.n).toFixed(1);
    r.line = +(r.line / r.n).toFixed(1);
  });
  return out;
}

// live injury report, same shape picks.js's fetchNbaInjuries builds
async function fetchInjuries() {
  try {
    const d = await fetchJson(SITE + "/injuries");
    const map = {};
    (d.injuries || []).forEach((t) => {
      map[t.id] = (t.injuries || []).map((i) => {
        const href = ((i.athlete && i.athlete.links) || []).map((l) => l.href || "").join(" ");
        const m = /\/id\/(\d+)/.exec(href);
        return { pid: m ? m[1] : null, status: i.status };
      });
    });
    return map;
  } catch (e) {
    console.error("[nba-stats] injuries: " + e.message);
    return {};
  }
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
  const r1 = (v) => Math.round(v * 10) / 10;
  d.athletes.forEach((a) => {
    const gp = val(a, "general.gamesPlayed"), mpg = val(a, "general.avgMinutes"), ppg = val(a, "offensive.avgPoints");
    if (!(gp > 0) || !isFinite(ppg)) return;
    // Hollinger Game Score per game (rebounds not split off/def here, so a
    // flat 0.4 weight) — a box-score all-in-one value, not just scoring
    const v = (k) => val(a, k) || 0;
    const gs = ppg + 0.4 * v("offensive.avgFieldGoalsMade") - 0.7 * v("offensive.avgFieldGoalsAttempted") -
      0.4 * (v("offensive.avgFreeThrowsAttempted") - v("offensive.avgFreeThrowsMade")) +
      0.4 * v("general.avgRebounds") + v("defensive.avgSteals") + 0.7 * v("offensive.avgAssists") +
      0.7 * v("defensive.avgBlocks") - v("offensive.avgTurnovers");
    out[a.athlete.id] = { n: a.athlete.displayName, s: season, gp, mpg: r1(mpg), ppg: r1(ppg), gs: r1(gs) };
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
    // a regular season alone is 1230 games — only stop retrying once most of
    // it is in (a failed ESPN run used to mark the backfill done for good)
    const have = Object.values(store.games).filter((g) => g.season === lastSeason).length;
    if (have >= BACKFILL_MIN_GAMES) store.backfilled[lastSeason] = true;
    console.log("[nba-stats] backfilled season " + lastSeason + ": " + n + " new game(s), " + have + " stored" +
      (store.backfilled[lastSeason] ? "" : " (incomplete, will retry)"));
  }
  const today = etDate(new Date(now));
  const recent = dateRange(etDate(new Date(now - 4 * 86400000)), today);
  const added = await topUpGames(store, recent);
  for (const id of Object.keys(store.games)) {
    if (store.games[id].season < lastSeason) delete store.games[id];
  }
  const lines = await fillLines(store, season);

  const teamList = await fetchJson(SITE + "/teams");
  const teamIds = teamList.sports[0].leagues[0].teams.map((t) => t.team.id);
  const names = {}, abbr = {};
  teamList.sports[0].leagues[0].teams.forEach((t) => { names[t.team.id] = t.team.displayName; abbr[t.team.id] = t.team.abbreviation; });
  const missingArena = teamIds.filter((id) => !ARENAS[abbr[id]]);
  if (missingArena.length) console.error("[nba-stats] no arena for: " + missingArena.map((id) => abbr[id]).join(", "));
  const arenaOf = (a) => ARENAS[a] || null;
  const abbrOf = (id) => abbr[id];

  // last season's ratings never change once it's over — compute once and keep
  let prevRatings = prevStats && prevStats.prevSeason === lastSeason && prevStats.prevRatings;
  if (!prevRatings || !Object.keys(prevRatings).length) prevRatings = await teamRatings(lastSeason, teamIds);
  const curRatings = await teamRatings(season, teamIds);
  // once this season has games, an empty/partial curRatings means ESPN failed —
  // writing stats.json now would silently drop to last season's ratings and
  // also reset the throttle, so nothing would retry for MIN_INTERVAL_MS
  // (compared against teams that have actually played, so opening week passes)
  const playedTeams = new Set();
  Object.values(store.games).forEach((g) => { if (g.season === season) { playedTeams.add(g.away); playedTeams.add(g.home); } });
  const seasonStarted = playedTeams.size > 0;
  if (seasonStarted && Object.keys(curRatings).length < playedTeams.size / 2) {
    fs.mkdirSync(DIR, { recursive: true });
    fs.writeFileSync(GAMES_FILE, JSON.stringify(store));
    console.error("[nba-stats] only " + Object.keys(curRatings).length + "/" + playedTeams.size +
      " team(s) rated for " + season + "; keeping the previous stats.json");
    process.exitCode = 1;
    return;
  }

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

  // per-team game history (date + arena) for fatigue, and recent form:
  // last RECENT_N games' average margin minus the season-to-date average
  const history = {}, margins = {};
  Object.values(store.games)
    .sort((a, b) => Date.parse(a.date) - Date.parse(b.date))
    .forEach((g) => {
      const at = abbrOf(g.home);
      const aPts = g.aq.reduce((x, y) => x + y, 0), hPts = g.hq.reduce((x, y) => x + y, 0);
      [[g.away, aPts - hPts], [g.home, hPts - aPts]].forEach(([t, m]) => {
        (history[t] || (history[t] = [])).push({ date: g.date, at });
        if (g.season === season) (margins[t] || (margins[t] = [])).push(m);
      });
    });
  const recentForm = (t) => {
    const m = margins[t] || [];
    if (m.length < 8) return null;
    const mean = (arr) => arr.reduce((x, y) => x + y, 0) / arr.length;
    return +(mean(m.slice(-RECENT_N)) - mean(m)).toFixed(2);
  };

  // fatigue features for the next two days' games. Rest/背靠背 come from the
  // schedule, so yesterday's and today's not-yet-finished games count too —
  // history above only has finished games, and this script often runs before
  // a late game ends (e.g. a 22:30 ET game, then the same team tomorrow,
  // showed 2 days' rest instead of a back-to-back).
  const boards = [];
  for (const ymd of [etDate(new Date(now - 86400000)), today, etDate(new Date(now + 86400000))]) {
    try { boards.push(await fetchJson(SITE + "/scoreboard?dates=" + ymd.replace(/-/g, ""))); } catch (e) { boards.push(null); }
  }
  const sides = (comp) => [comp.competitors.find((c) => c.homeAway === "away"), comp.competitors.find((c) => c.homeAway === "home")];
  const schedHistory = {};
  Object.keys(history).forEach((t) => { schedHistory[t] = history[t].slice(); });
  boards.forEach((sb) => (sb && sb.events || []).forEach((ev) => {
    const comp = ev.competitions && ev.competitions[0];
    if (!comp || store.games[ev.id] || /POSTPONED|CANCELED|SUSPENDED/.test(comp.status.type.name || "")) return;
    const [away, home] = sides(comp);
    if (!away || !home) return;
    const at = abbrOf(home.team.id);
    [away, home].forEach((c) => (schedHistory[c.team.id] || (schedHistory[c.team.id] = [])).push({ date: ev.date, at }));
  }));
  const upcoming = {}, upcomingTeams = {};
  boards.slice(1).forEach((sb) => (sb && sb.events || []).forEach((ev) => {
    const comp = ev.competitions && ev.competitions[0];
    if (!comp || comp.status.type.state !== "pre") return;
    const [away, home] = sides(comp);
    if (!home || !away) return;
    const at = abbrOf(home.team.id);
    upcomingTeams[ev.id] = { a: away.team.id, h: home.team.id, date: ev.date };
    upcoming[ev.id] = {
      h: fatigue(schedHistory[home.team.id] || [], ev.date, at, arenaOf),
      a: fatigue(schedHistory[away.team.id] || [], ev.date, at, arenaOf),
      alt: (arenaOf(at) || [])[3] ? 1 : 0,
    };
  }));

  const teams = {};
  teamIds.forEach((id) => {
    const r = blend(curRatings[id], prevRatings[id]);
    const s = h1[id];
    teams[id] = {
      name: names[id],
      gp: r ? r.gp : 0, prevGp: r ? r.prevGp || 0 : 0,
      pace: r ? +r.pace.toFixed(2) : null,
      paceCur: r && r.paceCur ? +r.paceCur.toFixed(2) : null,
      ortg: r ? +r.ortg.toFixed(2) : null,
      drtg: r ? +r.drtg.toFixed(2) : null,
      h1Share: s && s.reg ? +(s.h1 / s.reg).toFixed(4) : null,
      h1Games: s ? Math.round(s.n) : 0,
      recent: recentForm(id),
    };
  });
  const rated = teamIds.map((id) => teams[id]).filter((t) => t.pace);
  const avg = (k) => rated.reduce((x, t) => x + t[k], 0) / (rated.length || 1);

  let curPlayers = {}, prevPlayers = (prevStats && prevStats.prevSeason === lastSeason &&
    prevStats.playersVersion === PLAYERS_VERSION && prevStats.prevPlayers) || null;
  try { curPlayers = await playerStats(season); } catch (e) { console.error("[nba-stats] players " + season + ": " + e.message); }
  // same idea for injuries' player values: keep the last good current-season set
  if (seasonStarted && !Object.keys(curPlayers).length && prevStats && prevStats.season === season && prevStats.players) {
    console.error("[nba-stats] no " + season + " player stats; reusing the previous build's");
    Object.keys(prevStats.players).forEach((id) => { if (prevStats.players[id].s === season) curPlayers[id] = prevStats.players[id]; });
  }
  if (!prevPlayers) {
    try { prevPlayers = await playerStats(lastSeason); } catch (e) { prevPlayers = {}; console.error("[nba-stats] players " + lastSeason + ": " + e.message); }
  }
  const players = Object.assign({}, prevPlayers);
  Object.keys(curPlayers).forEach((id) => { if (curPlayers[id].gp >= 5 || !players[id]) players[id] = curPlayers[id]; });

  const out = {
    updated: new Date(now).toISOString(),
    season, prevSeason: lastSeason,
    league: { pace: +avg("pace").toFixed(2), ortg: +avg("ortg").toFixed(2), h1Share: +lgShare.toFixed(4) },
    teams, players, upcoming,
    trends: lineTrends(store.games, season),
    calib: calibrate(store.games, arenaOf, abbrOf),
    playersVersion: PLAYERS_VERSION,
    prevRatings, prevPlayers,
  };
  // what picks.js would predict for each not-yet-started game right now
  const projLog = readJson(PROJ_LOG_FILE, { games: {} });
  const injuries = await fetchInjuries();
  let logged = 0;
  for (const id of Object.keys(upcomingTeams)) {
    const u = upcomingTeams[id];
    let espnH = null;
    try {
      const s = await fetchJson(SITE + "/summary?event=" + id);
      const pr = s.predictor;
      const aP = pr && pr.awayTeam && parseFloat(pr.awayTeam.gameProjection);
      const hP = pr && pr.homeTeam && parseFloat(pr.homeTeam.gameProjection);
      if (aP && hP && aP + hP > 0) espnH = hP / (aP + hP);
    } catch (e) { /* model without the ESPN half, as picks.js does */ }
    const p = projectGame(out, injuries, u.a, u.h, id, espnH);
    if (!p) continue;
    projLog.games[id] = Object.assign({ date: u.date, at: out.updated }, p);
    logged++;
  }
  for (const id of Object.keys(projLog.games)) {
    if (now - Date.parse(projLog.games[id].date) > PROJ_LOG_KEEP_MS) delete projLog.games[id];
  }
  out.calib = Object.assign(out.calib || {}, { deployed: calibrateDeployed(projLog, store.games) });

  fs.mkdirSync(DIR, { recursive: true });
  fs.writeFileSync(GAMES_FILE, JSON.stringify(store));
  fs.writeFileSync(STATS_FILE, JSON.stringify(out));
  fs.writeFileSync(PROJ_LOG_FILE, JSON.stringify(projLog));
  console.log("[nba-stats] lines: " + lines.filled + "/" + lines.tried + " filled; upcoming " + Object.keys(upcoming).length +
    "; calib " + (out.calib.games ? out.calib.games + " games" : "skipped") +
    "; deployed calib " + out.calib.deployed.games + " games" + (out.calib.deployed.ready ? "" : " (not ready)") +
    "; logged " + logged + " projection(s)");
  console.log("[nba-stats] " + added + " new game(s); " + Object.keys(store.games).length + " stored; " +
    rated.length + " team(s) rated (current season: " + Object.keys(curRatings).length + "); " +
    Object.keys(players).length + " player(s); league h1 share " + lgShare.toFixed(4));
})().catch((e) => { console.error("[nba-stats] failed: " + (e && e.message)); process.exit(1); });
