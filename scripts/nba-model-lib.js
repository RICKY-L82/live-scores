"use strict";
/*
 * Shared NBA model pieces for scripts/collect-nba-stats.js: arena table,
 * schedule-fatigue features, the backtest that calibrates the coefficients
 * assets/js/picks.js applies (stats.json → calib), a Node copy of picks.js's
 * projection used to log what the page predicted before each game, and the
 * calibration of the market weights against that log (calib.deployed).
 */

// lat, lon, UTC offset (standard time), high altitude
const ARENAS = {
  ATL: [33.757, -84.396, -5], BOS: [42.366, -71.062, -5], BKN: [40.683, -73.976, -5],
  CHA: [35.225, -80.839, -5], CHI: [41.881, -87.674, -6], CLE: [41.497, -81.688, -5],
  DAL: [32.790, -96.810, -6], DEN: [39.749, -105.008, -7, true], DET: [42.341, -83.055, -5],
  GS: [37.768, -122.388, -8], HOU: [29.751, -95.362, -6], IND: [39.764, -86.155, -5],
  LAC: [33.945, -118.341, -8], LAL: [34.043, -118.267, -8], MEM: [35.138, -90.051, -6],
  MIA: [25.781, -80.188, -5], MIL: [43.045, -87.917, -6], MIN: [44.979, -93.276, -6],
  NO: [29.949, -90.082, -6], NY: [40.751, -73.993, -5], OKC: [35.463, -97.515, -6],
  ORL: [28.539, -81.384, -5], PHI: [39.901, -75.172, -5], PHX: [33.446, -112.071, -7],
  POR: [45.532, -122.667, -8], SAC: [38.580, -121.500, -8], SA: [29.427, -98.438, -6],
  TOR: [43.643, -79.379, -5], UTAH: [40.768, -111.901, -7, true], WSH: [38.898, -77.021, -5],
};

function km(a, b) {
  const R = 6371, r = Math.PI / 180;
  const dLat = (b[0] - a[0]) * r, dLon = (b[1] - a[1]) * r;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a[0] * r) * Math.cos(b[0] * r) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
function etDay(iso) {
  const s = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(new Date(iso));
  return Date.parse(s + "T00:00:00Z") / 86400000;
}

// history: this team's earlier games [{date, at}] (at = arena abbr), any order
function fatigue(history, gameIso, arenaAbbr, arenaOf) {
  const day = etDay(gameIso);
  const prior = history
    .filter((g) => etDay(g.date) < day)
    .sort((a, b) => Date.parse(b.date) - Date.parse(a.date));
  const out = { rest: null, b2b: 0, threeIn4: 0, travel: 0, tz: 0 };
  if (!prior.length) return out;
  const last = prior[0];
  const gap = day - etDay(last.date);
  out.rest = gap - 1;
  out.b2b = gap === 1 ? 1 : 0;
  out.threeIn4 = prior.filter((g) => day - etDay(g.date) <= 3).length >= 2 ? 1 : 0;
  const from = arenaOf(last.at), to = arenaOf(arenaAbbr);
  if (from && to && gap <= 3) {
    out.travel = Math.round(km(from, to)) / 1000; // thousands of km, only when legs are back-to-back-ish
    out.tz = Math.abs(from[2] - to[2]);
  }
  return out;
}

// ---------- tiny ridge regression ----------
function ridge(X, y, lambda) {
  const k = X[0].length;
  const A = Array.from({ length: k }, () => new Array(k).fill(0));
  const b = new Array(k).fill(0);
  X.forEach((row, i) => {
    for (let p = 0; p < k; p++) {
      b[p] += row[p] * y[i];
      for (let q = 0; q < k; q++) A[p][q] += row[p] * row[q];
    }
  });
  for (let p = 1; p < k; p++) A[p][p] += lambda; // don't shrink the intercept
  // Gaussian elimination
  for (let c = 0; c < k; c++) {
    let piv = c;
    for (let r = c + 1; r < k; r++) if (Math.abs(A[r][c]) > Math.abs(A[piv][c])) piv = r;
    [A[c], A[piv]] = [A[piv], A[c]]; [b[c], b[piv]] = [b[piv], b[c]];
    for (let r = 0; r < k; r++) {
      if (r === c || !A[c][c]) continue;
      const f = A[r][c] / A[c][c];
      for (let q = c; q < k; q++) A[r][q] -= f * A[c][q];
      b[r] -= f * b[c];
    }
  }
  return b.map((v, i) => v / A[i][i]);
}
function sd(arr) {
  const m = arr.reduce((x, y) => x + y, 0) / arr.length;
  return Math.sqrt(arr.reduce((x, y) => x + (y - m) ** 2, 0) / Math.max(1, arr.length - 1));
}
const r2 = (v, d) => Math.round(v * 10 ** d) / 10 ** d;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const normCdf = (z) => {
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989423 * Math.exp(-z * z / 2);
  const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return z > 0 ? 1 - p : p;
};
// Acklam's inverse normal CDF, same as assets/js/picks.js invNormCdf
function invNormCdf(p) {
  p = clamp(p, 1e-6, 1 - 1e-6);
  const a = [-3.969683028665376e+01, 2.209460984245205e+02, -2.759285104469687e+02, 1.383577518672690e+02, -3.066479806614716e+01, 2.506628277459239e+00];
  const b = [-5.447609879822406e+01, 1.615858368580409e+02, -1.556989798598866e+02, 6.680131188771972e+01, -1.328068155288572e+01];
  const c = [-7.784894002430293e-03, -3.223964580411365e-01, -2.400758277161838e+00, -2.549732539343734e+00, 4.374664141464968e+00, 2.938163982698783e+00];
  const d = [7.784695709041462e-03, 3.224671290700398e-01, 2.445134137142996e+00, 3.754408661907416e+00];
  const plow = 0.02425;
  if (p < plow || p > 1 - plow) {
    const q = Math.sqrt(-2 * Math.log(p < plow ? p : 1 - p));
    const v = (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
    return p < plow ? v : -v;
  }
  const q = p - 0.5, r = q * q;
  return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q /
    (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}
const impliedProb = (american) => {
  const o = Number(String(american === undefined || american === null ? "" : american).replace(/^\+/, ""));
  if (!isFinite(o) || o === 0) return null;
  return o < 0 ? -o / (-o + 100) : 100 / (o + 100);
};

/*
 * Walk every stored game in date order with season-to-date (no look-ahead)
 * point ratings shrunk toward the league mean, build features, and fit:
 *   margin = β·baseMargin + HCA + fatigue terms + altitude + recent form
 *   total  = c0 + c1·baseTotal + fatigue terms
 * then residual SDs (full game, first half) and, on games with DraftKings
 * closing lines, how much weight the model deserves vs. the market plus a
 * hit-rate table by model-vs-line disagreement.
 */
function calibrate(games, arenaOf, abbrOf) {
  const list = Object.values(games).sort((a, b) => Date.parse(a.date) - Date.parse(b.date));
  const K = 10;
  const acc = {}; // `${season}:${team}` → running sums + history
  const lg = {}; // season → {pts, n}
  const hist = {}; // team → [{date, at}] across seasons (fatigue spans the season boundary harmlessly)
  const rows = [];
  for (const g of list) {
    const aPts = g.aq.reduce((x, y) => x + y, 0); // aq/hq include overtime periods
    const hPts = g.hq.reduce((x, y) => x + y, 0);
    const L = lg[g.season] || (lg[g.season] = { pts: 0, n: 0 });
    const lgAvg = L.n ? L.pts / L.n : 114;
    const st = (t) => acc[g.season + ":" + t] || (acc[g.season + ":" + t] = { n: 0, pf: 0, pa: 0, margins: [] });
    const A = st(g.away), H = st(g.home);
    const rate = (s, k) => (s[k] + K * lgAvg) / (s.n + K);
    const at = abbrOf(g.home);
    if (A.n >= 5 && H.n >= 5) {
      const baseH = (rate(H, "pf") + rate(A, "pa")) / 2, baseA = (rate(A, "pf") + rate(H, "pa")) / 2;
      const fa = fatigue(hist[g.away] || [], g.date, at, arenaOf), fh = fatigue(hist[g.home] || [], g.date, at, arenaOf);
      const recent = (s) => {
        if (s.margins.length < 8) return 0;
        const last = s.margins.slice(-10);
        return last.reduce((x, y) => x + y, 0) / last.length - s.margins.reduce((x, y) => x + y, 0) / s.margins.length;
      };
      const alt = (arenaOf(at) || [])[3] ? 1 : 0;
      rows.push({
        g, baseMargin: baseH - baseA, baseTotal: baseH + baseA,
        margin: hPts - aPts, total: hPts + aPts,
        h1: g.aq[0] + g.aq[1] + g.hq[0] + g.hq[1],
        fh, fa, alt, recentDiff: recent(H) - recent(A),
      });
    }
    A.n++; A.pf += aPts; A.pa += hPts; A.margins.push(aPts - hPts);
    H.n++; H.pf += hPts; H.pa += aPts; H.margins.push(hPts - aPts);
    L.pts += aPts + hPts; L.n += 2;
    (hist[g.away] || (hist[g.away] = [])).push({ date: g.date, at });
    (hist[g.home] || (hist[g.home] = [])).push({ date: g.date, at });
  }
  if (rows.length < 200) return null;

  // away-minus-home differences: positive = the away side is more tired,
  // which should help the home margin — one coefficient per factor keeps
  // the fit stable on a single season
  const MX = (r) => [1, r.baseMargin, r.fa.b2b - r.fh.b2b, r.fa.threeIn4 - r.fh.threeIn4,
    r.fa.travel - r.fh.travel, r.fa.tz - r.fh.tz, r.alt, r.recentDiff];
  const mb = ridge(rows.map(MX), rows.map((r) => r.margin), 20);
  const TX = (r) => [1, r.baseTotal];
  const tb = ridge(rows.map(TX), rows.map((r) => r.total), 5);
  const dot = (w, x) => w.reduce((s, v, i) => s + v * x[i], 0);

  rows.forEach((r) => { r.predMargin = dot(mb, MX(r)); r.predTotal = dot(tb, TX(r)); });
  const marginSd = sd(rows.map((r) => r.margin - r.predMargin));
  const totalSd = sd(rows.map((r) => r.total - r.predTotal));
  const lgShare = rows.reduce((s, r) => s + r.h1, 0) / rows.reduce((s, r) => s + r.total, 0);
  const h1Sd = sd(rows.map((r) => r.h1 - r.predTotal * lgShare));

  // model vs. DraftKings closing line
  const lined = rows.filter((r) => r.g.ln && isFinite(r.g.ln.hl) && isFinite(r.g.ln.tot));
  let market = null;
  if (lined.length >= 150) {
    const wM = ridge(lined.map((r) => [1, r.predMargin, -r.g.ln.hl]), lined.map((r) => r.margin), 1);
    const wT = ridge(lined.map((r) => [1, r.predTotal, r.g.ln.tot]), lined.map((r) => r.total), 1);
    const share = (a, b) => clamp(a / ((a > 0 ? a : 0) + (b > 0 ? b : 0) || 1), 0, 1);
    const hit = (pred, line, act, th) => {
      let w = 0, n = 0;
      lined.forEach((r) => {
        const d = pred(r) - line(r);
        if (Math.abs(d) < th) return;
        const res = act(r) - line(r);
        if (res === 0) return;
        n++; if (Math.sign(res) === Math.sign(d)) w++;
      });
      return { n, hit: n ? r2(w / n, 3) : null };
    };
    const thresholds = [1, 2, 3, 4, 5];
    market = {
      games: lined.length,
      spreadModelWeight: r2(share(wM[1], wM[2]), 3),
      totalModelWeight: r2(share(wT[1], wT[2]), 3),
      lineMarginSd: r2(sd(lined.map((r) => r.margin + r.g.ln.hl)), 2),
      lineTotalSd: r2(sd(lined.map((r) => r.total - r.g.ln.tot)), 2),
      spreadHitByGap: thresholds.map((th) => Object.assign({ gap: th },
        hit((r) => r.predMargin, (r) => -r.g.ln.hl, (r) => r.margin, th))),
      totalHitByGap: thresholds.map((th) => Object.assign({ gap: th },
        hit((r) => r.predTotal, (r) => r.g.ln.tot, (r) => r.total, th))),
    };
  }

  // in-sample ML calibration of the margin model (Brier vs. a coin flip)
  const brier = rows.reduce((s, r) => s + (normCdf(r.predMargin / marginSd) - (r.margin > 0 ? 1 : 0)) ** 2, 0) / rows.length;

  // picks.js only takes the additive adjustments (its own possession-based
  // projection replaces baseMargin), each clamped to a plausible sign/range;
  // raw holds the unclamped fit for inspection
  return {
    updated: new Date().toISOString(),
    games: rows.length,
    margin: {
      hca: r2(clamp(mb[0], 1, 4), 2),
      b2b: r2(clamp(mb[2], 0, 3), 2),
      threeIn4: r2(clamp(mb[3], 0, 2), 2),
      travel: r2(clamp(mb[4], 0, 1.5), 2),
      tz: r2(clamp(mb[5], 0, 1.5), 2),
      altitude: r2(clamp(mb[6], 0, 3), 2),
      recent: r2(clamp(mb[7], 0, 0.6), 3),
      sd: r2(marginSd, 2),
      raw: mb.map((v) => r2(v, 3)),
    },
    total: { sd: r2(totalSd, 2) },
    h1: { share: r2(lgShare, 4), sd: r2(h1Sd, 2) },
    brier: r2(brier, 4),
    market,
  };
}

// ---------- what assets/js/picks.js predicts (keep in sync with its nbaProjection) ----------
const NBA_DEFAULT_MARGIN = { hca: 2, b2b: 1.4, threeIn4: 0.8, travel: 0, tz: 0.8, altitude: 0, recent: 0.25, sd: 14.5 };
const INJ_FACTOR = 0.3, INJ_REPL_PER_MIN = 0.15, INJ_CAP = 10;
const INJ_WEIGHT = { "Out": 1, "Doubtful": 0.75, "Questionable": 0.5, "Day-To-Day": 0.4 };
function injuryPts(list, team, players, season) {
  let total = 0;
  (list || []).forEach((inj) => {
    const w = INJ_WEIGHT[inj.status];
    const p = inj.pid && players[inj.pid];
    if (!w || !p || p.mpg < 10) return;
    const value = isFinite(p.gs) ? p.gs - INJ_REPL_PER_MIN * p.mpg : 0.5 * p.ppg;
    const baked = p.s !== season && team && team.gp ? team.gp / (team.gp + 15) : 0;
    const pts = INJ_FACTOR * Math.max(0, value) * w * (1 - baked);
    if (pts >= 0.3) total += pts;
  });
  return Math.min(total, INJ_CAP);
}
// injuries: { teamId: [{pid, status}] } from ESPN's injury report; espnH:
// ESPN predictor home win share or null. Returns the model inputs picks.js
// feeds into its market blend: own margin/total, the ESPN-blended margin
// (mu) and win probability (winH).
function projectGame(stats, injuries, aId, hId, eventId, espnH) {
  const aT = stats && stats.teams[aId], hT = stats && stats.teams[hId], L = stats && stats.league;
  if (!aT || !hT || !aT.pace || !hT.pace || !L || !L.pace || !L.ortg) return null;
  const C = (stats.calib && stats.calib.margin) || NBA_DEFAULT_MARGIN;
  const pace = aT.pace * hT.pace / L.pace;
  const aBase = pace * (aT.ortg * hT.drtg / L.ortg) / 100;
  const hBase = pace * (hT.ortg * aT.drtg / L.ortg) / 100;
  let adj = C.hca;
  const f = stats.upcoming && stats.upcoming[eventId];
  if (f) {
    const add = (coef, diff) => { if (coef && diff) adj += coef * diff; };
    add(C.b2b, f.a.b2b - f.h.b2b);
    add(C.threeIn4, f.a.threeIn4 - f.h.threeIn4);
    add(C.tz, f.a.tz - f.h.tz);
    add(C.travel, f.a.travel - f.h.travel);
    add(C.altitude, f.alt);
  }
  if (C.recent && aT.recent !== null && hT.recent !== null && aT.recent !== undefined && hT.recent !== undefined) {
    adj += C.recent * (hT.recent - aT.recent);
  }
  const aInj = injuryPts(injuries[aId], aT, stats.players || {}, stats.season);
  const hInj = injuryPts(injuries[hId], hT, stats.players || {}, stats.season);
  const margin = hBase - aBase + adj - hInj + aInj;
  const total = aBase + hBase - aInj - hInj;
  const winOwn = normCdf(margin / C.sd);
  const hasEspn = espnH !== null && espnH !== undefined && isFinite(espnH);
  return {
    margin: r2(margin, 2), total: r2(total, 2),
    espnH: hasEspn ? r2(espnH, 4) : null,
    mu: r2(hasEspn ? (margin + C.sd * invNormCdf(espnH)) / 2 : margin, 2),
    winH: r2(hasEspn ? (winOwn + espnH) / 2 : winOwn, 4),
  };
}

/*
 * Market weights for the model picks.js actually runs, fitted on its own
 * pre-game projections (data/nba/proj-log.json) against results and the
 * DraftKings close. calibrate() above can only rebuild a points-per-game
 * model from games.json — no historical pace/efficiency, injuries or ESPN
 * predictor — so its market weights describe a different model. picks.js
 * switches to these once `ready` (enough logged games).
 */
const DEPLOYED_MIN_GAMES = 200;
function calibrateDeployed(log, games) {
  const rows = [];
  Object.keys((log && log.games) || {}).forEach((id) => {
    const p = log.games[id], g = games[id];
    if (!g || !g.ln || !isFinite(g.ln.hl) || !isFinite(g.ln.tot)) return;
    const aPts = g.aq.reduce((x, y) => x + y, 0), hPts = g.hq.reduce((x, y) => x + y, 0);
    rows.push({ p, ln: g.ln, margin: hPts - aPts, total: aPts + hPts });
  });
  if (rows.length < 30) return { games: rows.length, ready: false };
  const mean = (arr) => arr.reduce((x, y) => x + y, 0) / arr.length;
  // the model's average miss on totals (e.g. early-season unders), removed
  // before the model is weighed against the line
  const totalBias = clamp(mean(rows.map((r) => r.total - r.p.total)), -8, 8);
  const share = (a, b) => clamp(a / ((a > 0 ? a : 0) + (b > 0 ? b : 0) || 1), 0, 1);
  const wM = ridge(rows.map((r) => [1, r.p.mu, -r.ln.hl]), rows.map((r) => r.margin), 1);
  const wT = ridge(rows.map((r) => [1, r.p.total + totalBias, r.ln.tot]), rows.map((r) => r.total), 1);
  // moneyline: blend weight with the lowest Brier score against the no-vig close
  const mlRows = rows.filter((r) => r.ln.ml && impliedProb(r.ln.ml[0]) !== null && impliedProb(r.ln.ml[1]) !== null && r.margin !== 0);
  let mlModelWeight = null;
  if (mlRows.length >= 30) {
    let best = Infinity;
    for (let i = 0; i <= 20; i++) {
      const w = i / 20;
      const brier = mean(mlRows.map((r) => {
        const a = impliedProb(r.ln.ml[0]), h = impliedProb(r.ln.ml[1]);
        const pH = w * r.p.winH + (1 - w) * h / (a + h);
        return (pH - (r.margin > 0 ? 1 : 0)) ** 2;
      }));
      if (brier < best - 1e-9) { best = brier; mlModelWeight = w; }
    }
  }
  const hit = (gap, res) => [1, 2, 3, 4, 5].map((th) => {
    let w = 0, n = 0;
    rows.forEach((r) => {
      const d = gap(r);
      if (Math.abs(d) < th) return;
      const x = res(r);
      if (x === 0) return;
      n++; if (Math.sign(x) === Math.sign(d)) w++;
    });
    return { gap: th, n, hit: n ? r2(w / n, 3) : null };
  });
  return {
    games: rows.length,
    ready: rows.length >= DEPLOYED_MIN_GAMES,
    spreadModelWeight: r2(share(wM[1], wM[2]), 3),
    totalModelWeight: r2(share(wT[1], wT[2]), 3),
    mlModelWeight, mlGames: mlRows.length,
    totalBias: r2(totalBias, 2),
    spreadHitByGap: hit((r) => r.p.mu + r.ln.hl, (r) => r.margin + r.ln.hl),
    totalHitByGap: hit((r) => r.p.total + totalBias - r.ln.tot, (r) => r.total - r.ln.tot),
  };
}

module.exports = { ARENAS, fatigue, calibrate, projectGame, calibrateDeployed };
