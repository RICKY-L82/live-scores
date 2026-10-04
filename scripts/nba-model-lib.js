"use strict";
/*
 * Shared NBA model pieces for scripts/collect-nba-stats.js: arena table,
 * schedule-fatigue features, and the backtest that calibrates the
 * coefficients assets/js/picks.js applies (data/nba/calibration.json).
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

module.exports = { ARENAS, fatigue, calibrate };
