(function () {
  "use strict";

  // Ranks today's best bets across MLB (moneyline + NRFI/YRFI) and NBA
  // (moneyline vs. ESPN predictor). Every candidate is scored by "edge":
  // model probability minus the market's break-even probability, so the
  // different bet types can be sorted on one scale.
  var NRFI_PRICE = "-110"; // no NRFI market in the free feed; assume the common price
  var TOP_N = 5;

  // populated from data/picks-stats.json before render() runs; null until that
  // fetch resolves (or on first deploy, before scripts/record-picks.js /
  // scripts/settle-picks.js have produced the file yet)
  var picksStats = null;

  // labels for the day/week/month win-rate table and each section's own
  // 30-day badge — keyed the same way scripts/record-picks.js groups its
  // snapshot, so the stats file's section keys line up with these directly
  var SECTION_META = {
    mlb_fi: "⚾ MLB 首局 NRFI / YRFI",
    mlb_ou: "⚾ MLB 大小分 Over/Under",
    mlb_sp: "⚾ MLB 讓分 Run Line",
    mlb_ml: "⚾ MLB 獨贏勝率",
    mlb_ml_edge: "⚾ MLB 獨贏優勢",
    wnba_ou: "🏀 WNBA 大小分 Over/Under",
    wnba_sp: "🏀 WNBA 讓分 Spread",
    nba_ml: "🏀 NBA 獨贏勝率",
    kbo_ml: "🇰🇷 KBO 獨贏勝率",
    kbo_ou: "🇰🇷 KBO 大小分 Over/Under",
    kbo_sp: "🇰🇷 KBO 讓分 Run Line",
    npb_ml: "🇯🇵 NPB 獨贏勝率",
    npb_ou: "🇯🇵 NPB 大小分 Over/Under",
    npb_sp: "🇯🇵 NPB 讓分 Run Line",
  };

  // ---------- helpers (mirrors assets/js/app.js) ----------
  function esc(s) {
    if (s === null || s === undefined) return "";
    return String(s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }
  function toISODate(d) {
    var y = d.getFullYear();
    var m = String(d.getMonth() + 1).padStart(2, "0");
    var day = String(d.getDate()).padStart(2, "0");
    return y + "-" + m + "-" + day;
  }
  // MLB start times are UTC; render explicitly in Taiwan date + time
  function formatTime(iso) {
    if (!iso) return "";
    var d = new Date(iso);
    if (isNaN(d.getTime())) return "";
    return d.toLocaleString("zh-TW", {
      timeZone: "Asia/Taipei",
      month: "numeric", day: "numeric",
      hour: "2-digit", minute: "2-digit", hour12: false,
    });
  }
  function fetchJson(url) {
    var ctrl = typeof AbortController !== "undefined" ? new AbortController() : null;
    var timer = ctrl ? setTimeout(function () { ctrl.abort(); }, 20000) : null;
    return fetch(url, ctrl ? { signal: ctrl.signal } : undefined)
      .then(function (res) {
        if (!res.ok) throw new Error("API " + res.status);
        return res.json();
      })
      .finally(function () { if (timer) clearTimeout(timer); });
  }
  function impliedProb(american) {
    var o = Number(String(american || "").replace(/^\+/, ""));
    if (isNaN(o) || o === 0) return null;
    return o < 0 ? (-o) / ((-o) + 100) : 100 / (o + 100);
  }
  function pctStr(p) { return (p * 100).toFixed(1) + "%"; }
  function clampNum(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }

  // vig-free probabilities from a two-way moneyline
  function fairProbs(mlA, mlH) {
    var a = impliedProb(mlA), h = impliedProb(mlH);
    if (a === null || h === null || a + h === 0) return null;
    return { away: a / (a + h), home: h / (a + h) };
  }

  function halfKellyStr(prob, american) {
    var o = Number(String(american || "").replace(/^\+/, ""));
    if (isNaN(o) || o === 0) return null;
    var b = o > 0 ? o / 100 : 100 / (-o);
    var kelly = (b * prob - (1 - prob)) / b;
    if (kelly <= 0) return null;
    return (kelly / 2 * 100).toFixed(1) + "%";
  }

  // ---------- game-total (大小分) model ----------
  // expected total runs: each side = (own runs scored + opponent runs allowed)/2,
  // nudged by each starter's season ERA vs the league average (falls back to the
  // static constant when today's pitcher pool is too small to derive one live —
  // see leagueEraFromPool()), plus park/weather run environment.
  var TOTAL_SD = 4.3; // empirical stdev of MLB combined runs
  var LEAGUE_ERA = 4.2; // fallback only; leagueEraFromPool() overrides per run
  var LEAGUE_AVG_BA = 0.244; // neutral baseline for the pitcher/hitter matchup deviations below
  function expectedTotalRuns(aRuns, hRuns, aEra, hEra, leagueEra, parkRunAdj, weatherRunAdj, awayOff, homeOff, aBullEra, hBullEra, leagueBullEra) {
    if (!aRuns || !hRuns || aRuns.rsAvg === null || hRuns.rsAvg === null) return null;
    leagueEra = isFinite(leagueEra) && leagueEra > 0 ? leagueEra : LEAGUE_ERA;
    var tot = (aRuns.rsAvg + hRuns.raAvg) / 2 + (hRuns.rsAvg + aRuns.raAvg) / 2;
    [aEra, hEra].forEach(function (e) {
      e = Number(e);
      if (isFinite(e) && e > 0) tot += clampNum((e - leagueEra) * 0.22, -0.7, 0.7);
    });
    // bullpen ERA gets its own, smaller nudge — a starter typically covers
    // more of a game's innings than the pen does, so this weighs less than
    // the starter-ERA term above
    leagueBullEra = isFinite(leagueBullEra) && leagueBullEra > 0 ? leagueBullEra : LEAGUE_ERA;
    [aBullEra, hBullEra].forEach(function (e) {
      e = Number(e);
      if (isFinite(e) && e > 0) tot += clampNum((e - leagueBullEra) * 0.15, -0.5, 0.5);
    });
    // each side's offense-vs-today's-opposing-starter matchup average (pitcher's
    // own history against this team blended with this lineup's own history
    // against this pitcher) nudges the total the same direction as a hot/cold
    // matchup would in practice
    [awayOff, homeOff].forEach(function (m) {
      if (m) tot += clampNum((m.avg - LEAGUE_AVG_BA) * 4, -0.4, 0.4);
    });
    tot += (parkRunAdj || 0) + (weatherRunAdj || 0);
    return clampNum(tot, 5, 13.5);
  }
  // derives today's live starter-ERA baseline from the actual probable-pitcher
  // pool instead of a fixed constant, so the total model doesn't silently drift
  // out of sync with the current run-scoring environment (e.g. a juiced/deadened
  // ball year). Needs a reasonably sized sample or it keeps the static fallback.
  function leagueEraFromPool(seasonStats, pitcherIds) {
    var vals = [];
    (pitcherIds || []).forEach(function (id) {
      var e = Number(seasonStats[id] && seasonStats[id].era);
      if (isFinite(e) && e > 0 && e < 15) vals.push(e);
    });
    if (vals.length < 10) return LEAGUE_ERA;
    return vals.reduce(function (a, b) { return a + b; }, 0) / vals.length;
  }
  // shrink a small-sample rate toward a league-wide prior (regression to the
  // mean) — with as few as 8 games behind offRate/defRate, a team's binary
  // first-inning outcomes are noisy (95% CI of roughly ±20 points on 15 games),
  // so unshrunk rates were feeding overconfident edges straight into picks.
  function shrinkRate(rate, n, prior, k) {
    if (rate === null || rate === undefined || prior === null || prior === undefined) return rate;
    k = k || 8;
    return (rate * n + prior * k) / (n + k);
  }
  // Abramowitz-Stegun normal CDF approximation
  function normCdf(z) {
    var t = 1 / (1 + 0.2316419 * Math.abs(z));
    var d = 0.3989423 * Math.exp(-z * z / 2);
    var p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
    return z > 0 ? 1 - p : p;
  }
  function overProbOf(expTot, line) {
    return 1 - normCdf((line - expTot) / TOTAL_SD);
  }
  // Acklam's rational approximation of the inverse normal CDF (probit),
  // used to turn a moneyline-style win probability into an implied expected
  // margin so run-line/point-spread cover probabilities can be derived from
  // the same win-probability models already built for NRFI/總分/獨贏.
  function invNormCdf(p) {
    p = clampNum(p, 1e-6, 1 - 1e-6);
    var a = [-3.969683028665376e+01, 2.209460984245205e+02, -2.759285104469687e+02,
      1.383577518672690e+02, -3.066479806614716e+01, 2.506628277459239e+00];
    var b = [-5.447609879822406e+01, 1.615858368580409e+02, -1.556989798598866e+02,
      6.680131188771972e+01, -1.328068155288572e+01];
    var c = [-7.784894002430293e-03, -3.223964580411365e-01, -2.400758277161838e+00,
      -2.549732539343734e+00, 4.374664141464968e+00, 2.938163982698783e+00];
    var d = [7.784695709041462e-03, 3.224671290700398e-01, 2.445134137142996e+00, 3.754408661907416e+00];
    var plow = 0.02425, phigh = 1 - plow, q, r;
    if (p < plow) {
      q = Math.sqrt(-2 * Math.log(p));
      return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
        ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
    }
    if (p <= phigh) {
      q = p - 0.5; r = q * q;
      return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q /
        (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
    }
    q = Math.sqrt(-2 * Math.log(1 - p));
    return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  // Home-team cover probability for a run-line/point-spread market, given only
  // a moneyline-style home win probability. Assumes the score margin is
  // Normal(mu, sigma) with mu backed out from winProb via the probit above;
  // sigma is approximated by the combined-score stdev already used for the
  // total-runs/total-points model (valid when home/away scoring are roughly
  // independent, since Var(home-away) = Var(home)+Var(away) = Var(home+away)
  // in that case). homeLine follows market convention: negative = home favored.
  function homeCoverProb(winProb, homeLine, sigma) {
    var mu = sigma * invNormCdf(winProb);
    return 1 - normCdf((-homeLine - mu) / sigma);
  }

  // ---------- playsport.cc fallback moneyline (台灣運彩盤) ----------
  // The guess page embeds "var vueData = {...}" with every listed game's
  // markets; gametype with isMoneyLine=true is the 獨贏 pair (option 1 = 主,
  // 2 = 客, decimal odds). The page only lists the current Taiwan day and has
  // no CORS headers, so it is fetched through a public proxy and each match
  // is verified against the MLB game's start time before being used.
  // public CORS proxies are individually flaky — try them in order
  var PS_PROXIES = [
    function (u) { return "https://api.allorigins.win/raw?url=" + encodeURIComponent(u); },
    function (u) { return "https://corsproxy.io/?url=" + encodeURIComponent(u); },
    function (u) { return "https://api.codetabs.com/v1/proxy?quest=" + encodeURIComponent(u); },
  ];
  var PS_TEAM = {
    "響尾蛇": "Arizona Diamondbacks", "勇士": "Atlanta Braves", "金鶯": "Baltimore Orioles",
    "紅襪": "Boston Red Sox", "小熊": "Chicago Cubs", "白襪": "Chicago White Sox",
    "紅人": "Cincinnati Reds", "守護者": "Cleveland Guardians", "落磯": "Colorado Rockies",
    "洛磯": "Colorado Rockies", "老虎": "Detroit Tigers", "太空人": "Houston Astros",
    "皇家": "Kansas City Royals", "天使": "Los Angeles Angels", "道奇": "Los Angeles Dodgers",
    "馬林魚": "Miami Marlins", "釀酒人": "Milwaukee Brewers", "雙城": "Minnesota Twins",
    "大都會": "New York Mets", "洋基": "New York Yankees", "運動家": "Athletics",
    "費城人": "Philadelphia Phillies", "海盜": "Pittsburgh Pirates", "教士": "San Diego Padres",
    "巨人": "San Francisco Giants", "水手": "Seattle Mariners", "紅雀": "St. Louis Cardinals",
    "光芒": "Tampa Bay Rays", "遊騎兵": "Texas Rangers", "藍鳥": "Toronto Blue Jays",
    "國民": "Washington Nationals",
  };

  function fetchText(url) {
    var ctrl = typeof AbortController !== "undefined" ? new AbortController() : null;
    var timer = ctrl ? setTimeout(function () { ctrl.abort(); }, 20000) : null;
    return fetch(url, ctrl ? { signal: ctrl.signal } : undefined)
      .then(function (res) {
        if (!res.ok) throw new Error("API " + res.status);
        return res.text();
      })
      .finally(function () { if (timer) clearTimeout(timer); });
  }

  // generic version of the retry-through-proxies pattern below, for other
  // no-CORS sources (KBO/NPB stats scraping)
  function fetchViaProxy(url, validator, idx) {
    idx = idx || 0;
    if (idx >= PS_PROXIES.length) return Promise.reject(new Error("all proxies failed"));
    return fetchText(PS_PROXIES[idx](url))
      .then(function (html) {
        if (validator && html.indexOf(validator) === -1) throw new Error("invalid content");
        return html;
      })
      .catch(function () { return fetchViaProxy(url, validator, idx + 1); });
  }

  function decToAmerican(dec) {
    dec = Number(dec);
    if (!isFinite(dec) || dec <= 1) return null;
    return dec >= 2 ? "+" + Math.round((dec - 1) * 100) : String(-Math.round(100 / (dec - 1)));
  }

  function fetchPlaysportHtml(idx) {
    if (idx >= PS_PROXIES.length) return Promise.reject(new Error("all proxies failed"));
    return fetchText(PS_PROXIES[idx]("https://www.playsport.cc/guess?allianceid=1"))
      .then(function (html) {
        if (html.indexOf("var vueData = {") === -1) throw new Error("no vueData");
        return html;
      })
      .catch(function () { return fetchPlaysportHtml(idx + 1); });
  }

  function fetchPlaysportMlMap() {
    return fetchPlaysportHtml(0)
      .then(function (html) {
        var m = html.match(/var vueData = (\{.+?\});(?:\r?\n)/);
        if (!m) return {};
        var data = JSON.parse(m[1]);
        var map = {};
        var lists = data.betGamesList || {};
        Object.keys(lists).forEach(function (day) {
          (lists[day] || []).forEach(function (g) {
            var awayEn = PS_TEAM[g.awayShortName], homeEn = PS_TEAM[g.homeShortName];
            if (!awayEn || !homeEn || Number(g.isClosed)) return;
            var mlPair = null;
            Object.keys(g.gametypes || {}).forEach(function (k) {
              var gt = g.gametypes[k];
              if (gt && gt["1"] && gt["1"].isMoneyLine && gt["2"]) mlPair = gt;
            });
            if (!mlPair) return;
            var h = decToAmerican(mlPair["1"].odds); // playsport 主
            var a = decToAmerican(mlPair["2"].odds); // playsport 客
            if (!a || !h) return;
            map[awayEn + "|" + homeEn] = {
              a: { open: null, cur: a },
              h: { open: null, cur: h },
              src: "playsport",
              ts: Number(g.timestamp) * 1000 || null,
            };
          });
        });
        return map;
      })
      .catch(function () { return {}; });
  }

  // ---------- The Odds API: real NRFI/YRFI prices ----------
  // Free MLB feeds (ESPN, playsport) carry no first-inning market. The Odds
  // API's per-event "totals_1st_1_innings" (Over/Under 0.5 = YRFI/NRFI) does,
  // but needs a free per-user key (the-odds-api.com, ~500 credits/month), so
  // the key is user-supplied via the 🔑 link and kept in localStorage. Odds
  // are cached 3h to stretch the quota; on any failure picks fall back to the
  // assumed -110 line.
  // three free-tier keys sharing the load; if one is out of monthly credits
  // (API 401/429) calls fall back to the next automatically. A manually-set
  // localStorage key opts out of the fallback list entirely — that's the
  // user's own key, not ours to substitute.
  var DEFAULT_ODDS_API_KEYS = ["3fc688e03b27b3d41eb04f761c7f58c3", "78782417cf4202b1e74da436e45b3ecd", "7d1f6397f3aa8d041a767e5dcb440d97"];
  function getOddsApiKeys() {
    try {
      var override = localStorage.getItem("oddsApiKey");
      return override ? [override] : DEFAULT_ODDS_API_KEYS;
    } catch (e) { return DEFAULT_ODDS_API_KEYS; }
  }
  function getOddsApiKey() { return getOddsApiKeys()[0]; } // for UI: "is a key configured", and the 🔑 prompt's current value
  // once a key is found to be exhausted this page load, skip straight past
  // it on later calls instead of re-attempting and waiting on a fresh 401/429
  // every time (resets on next page load, which is fine — quotas are monthly)
  var oddsApiDeadKeys = {};
  function fetchOddsApiWithFallback(urlForKey) {
    var keys = getOddsApiKeys().filter(function (k) { return !oddsApiDeadKeys[k]; });
    if (!keys.length) keys = getOddsApiKeys();
    function tryKey(i) {
      if (i >= keys.length) return Promise.reject(new Error("all Odds API keys exhausted"));
      return fetchJson(urlForKey(keys[i])).catch(function (err) {
        var quotaLike = /API (401|429)/.test(String(err && err.message || ""));
        if (quotaLike) {
          oddsApiDeadKeys[keys[i]] = true;
          if (i + 1 < keys.length) return tryKey(i + 1);
        }
        throw err;
      });
    }
    return tryKey(0);
  }

  function fetchNrfiOddsMap(games) {
    if (!getOddsApiKeys().length) return Promise.resolve({});
    var cache = null;
    try { cache = JSON.parse(localStorage.getItem("nrfiOddsCache")); } catch (e) {}
    if (cache && cache.t && Date.now() - cache.t < 3 * 3600 * 1000 && cache.map) {
      return Promise.resolve(cache.map);
    }
    var want = {};
    games.forEach(function (g) { want[g.teams.away.team.name + "|" + g.teams.home.team.name] = true; });
    return fetchOddsApiWithFallback(function (key) {
      return "https://api.the-odds-api.com/v4/sports/baseball_mlb/events?apiKey=" + encodeURIComponent(key);
    })
      .then(function (events) {
        var targets = (events || []).filter(function (ev) {
          return want[ev.away_team + "|" + ev.home_team];
        }).slice(0, 20);
        return Promise.all(targets.map(function (ev) {
          return fetchOddsApiWithFallback(function (key) {
            return "https://api.the-odds-api.com/v4/sports/baseball_mlb/events/" + ev.id +
              "/odds?apiKey=" + encodeURIComponent(key) +
              "&regions=us&markets=totals_1st_1_innings&oddsFormat=american";
          })
            .catch(function () { return null; });
        })).then(function (arr) {
          var map = {};
          arr.forEach(function (d) {
            if (!d) return;
            var found = null, book = null;
            (d.bookmakers || []).forEach(function (bk) {
              if (found) return;
              (bk.markets || []).forEach(function (mk) {
                if (found || mk.key !== "totals_1st_1_innings") return;
                var over = null, under = null;
                (mk.outcomes || []).forEach(function (oc) {
                  if (Number(oc.point) !== 0.5) return;
                  if (oc.name === "Over") over = oc.price;
                  else if (oc.name === "Under") under = oc.price;
                });
                if (over !== null && under !== null) {
                  found = { over: String(over), under: String(under) };
                  book = bk.title;
                }
              });
            });
            if (found) map[d.away_team + "|" + d.home_team] = { over: found.over, under: found.under, book: book || "book" };
          });
          try { localStorage.setItem("nrfiOddsCache", JSON.stringify({ t: Date.now(), map: map })); } catch (e) {}
          return map;
        });
      })
      .catch(function () { return {}; });
  }

  // ---------- ESPN moneyline map (open + current) ----------
  function extractMl(oddsArr) {
    if (!oddsArr || !oddsArr.length) return null;
    var o = oddsArr.find(function (x) { return x.moneyline; }) || oddsArr[0];
    if (o.moneyline) {
      function side(s) {
        var x = o.moneyline[s];
        if (!x) return null;
        return {
          open: x.open ? (x.open.odds || null) : null,
          cur: x.close ? (x.close.odds || null) : null,
        };
      }
      var a = side("away"), h = side("home");
      if (a && h && a.cur && h.cur) return { a: a, h: h };
      return null;
    }
    if (o.awayTeamOdds && o.awayTeamOdds.moneyLine !== undefined && o.homeTeamOdds && o.homeTeamOdds.moneyLine !== undefined) {
      return {
        a: { open: null, cur: String(o.awayTeamOdds.moneyLine) },
        h: { open: null, cur: String(o.homeTeamOdds.moneyLine) },
      };
    }
    return null;
  }
  function buildEspnMlMap(data) {
    var map = {};
    (data.events || []).forEach(function (ev) {
      var comp = ev.competitions && ev.competitions[0];
      if (!comp) return;
      var ml = extractMl(comp.odds);
      if (!ml) return;
      var home = (comp.competitors || []).find(function (c) { return c.homeAway === "home"; });
      var away = (comp.competitors || []).find(function (c) { return c.homeAway === "away"; });
      if (home && away) map[away.team.displayName + "|" + home.team.displayName] = ml;
    });
    return map;
  }

  // game-total market: line + over/under prices when posted, or the bare
  // overUnder number (prices assumed -110) before ESPN opens the juice
  function extractTot(oddsArr) {
    if (!oddsArr || !oddsArr.length) return null;
    var o = oddsArr.find(function (x) { return x.total || x.overUnder !== undefined; }) || oddsArr[0];
    if (o.total) {
      function side(s) {
        var x = o.total[s];
        return x && x.close ? { price: x.close.odds || null, line: x.close.line || null } : null;
      }
      var ov = side("over"), un = side("under");
      var line = Number(String((ov && ov.line) || (un && un.line) || "").replace(/^[ou]/i, ""));
      if (isFinite(line) && line > 0 && ov && un && ov.price && un.price) {
        return { line: line, over: String(ov.price), under: String(un.price), real: true };
      }
    }
    var bare = Number(o.overUnder);
    if (isFinite(bare) && bare > 0) return { line: bare, over: NRFI_PRICE, under: NRFI_PRICE, real: false };
    return null;
  }
  function buildEspnTotMap(data) {
    var map = {};
    (data.events || []).forEach(function (ev) {
      var comp = ev.competitions && ev.competitions[0];
      if (!comp) return;
      var tot = extractTot(comp.odds);
      if (!tot) return;
      var home = (comp.competitors || []).find(function (c) { return c.homeAway === "home"; });
      var away = (comp.competitors || []).find(function (c) { return c.homeAway === "away"; });
      if (home && away) map[away.team.displayName + "|" + home.team.displayName] = tot;
    });
    return map;
  }

  // 讓分/point-spread market: ESPN's "pointSpread" object (MLB run line is
  // almost always ±1.5; NBA/WNBA point spreads vary) — home line + price and
  // away line + price, prices assumed -110 only if ESPN omits them entirely.
  function extractSpread(oddsArr) {
    if (!oddsArr || !oddsArr.length) return null;
    var o = oddsArr.find(function (x) { return x.pointSpread; }) || oddsArr[0];
    if (!o.pointSpread) return null;
    function side(s) {
      var x = o.pointSpread[s];
      if (!x || !x.close) return null;
      var line = Number(x.close.line);
      return isFinite(line) ? { line: line, price: x.close.odds || NRFI_PRICE } : null;
    }
    var h = side("home"), a = side("away");
    if (!h || !a) return null;
    return { home: h, away: a };
  }
  function buildEspnSpreadMap(data) {
    var map = {};
    (data.events || []).forEach(function (ev) {
      var comp = ev.competitions && ev.competitions[0];
      if (!comp) return;
      var sp = extractSpread(comp.odds);
      if (!sp) return;
      var home = (comp.competitors || []).find(function (c) { return c.homeAway === "home"; });
      var away = (comp.competitors || []).find(function (c) { return c.homeAway === "away"; });
      if (home && away) map[away.team.displayName + "|" + home.team.displayName] = sp;
    });
    return map;
  }

  // open -> current shift of the vig-free home probability (percentage points)
  function mlMoveNote(ml, pickIsHome, awayName, homeName) {
    if (!ml.a.open || !ml.h.open) return null;
    var f0 = fairProbs(ml.a.open, ml.h.open);
    var f1 = fairProbs(ml.a.cur, ml.h.cur);
    if (!f0 || !f1) return null;
    var d = (f1.home - f0.home) * 100;
    if (Math.abs(d) < 1) return "盤口:開盤至今變動不大。";
    var hotSide = d > 0 ? homeName + "(主)" : awayName + "(客)";
    var agree = (d > 0) === pickIsHome;
    return "盤口:開盤至今 <b>" + esc(hotSide) + "</b> 隱含機率 +" + Math.abs(d).toFixed(1) +
      " 百分點," + (agree ? "與本推薦<b>同向</b>,市場資金也在買進這一邊" : "與本推薦<b>反向</b>,屬逆市注,注意風險") + "。";
  }

  // ---------- MLB data ----------
  function fetchMlbStandings(season) {
    return fetchJson("https://statsapi.mlb.com/api/v1/standings?leagueId=103,104&season=" + season)
      .then(function (d) {
        var map = {};
        (d.records || []).forEach(function (r) {
          (r.teamRecords || []).forEach(function (tr) {
            var lt = ((tr.records && tr.records.splitRecords) || []).find(function (x) { return x.type === "lastTen"; });
            var ht = ((tr.records && tr.records.splitRecords) || []).find(function (x) { return x.type === "home"; });
            map[tr.team.id] = {
              wins: tr.wins, losses: tr.losses,
              pct: Number(tr.winningPercentage || (tr.wins + tr.losses > 0 ? tr.wins / (tr.wins + tr.losses) : 0)),
              lastTen: lt ? lt.wins + "-" + lt.losses : null,
              streak: tr.streak ? tr.streak.streakCode : null,
              // home win% — only this team's home-field advantage is used to
              // gate the +3.5% home-advantage nudge below (see mlbModelHome)
              homeWinPct: ht ? Number(ht.pct || (ht.wins + ht.losses > 0 ? ht.wins / (ht.wins + ht.losses) : 0)) : null,
            };
          });
        });
        return map;
      })
      .catch(function () { return {}; });
  }

  // one call covers every team's bullpen ERA for the season (sitCodes=rp
  // splits pitching stats to relief appearances only); feeds the moneyline
  // and total-runs models the same way starter ERA already does. Not wired
  // into NRFI/YRFI — the bullpen never appears in the 1st inning, so it has
  // no bearing on that market.
  function fetchBullpenEraMap(season) {
    return fetchJson("https://statsapi.mlb.com/api/v1/teams/stats?stats=statSplits&sitCodes=rp&group=pitching&season=" +
        season + "&sportIds=1")
      .then(function (d) {
        var map = {};
        var splits = (d.stats && d.stats[0] && d.stats[0].splits) || [];
        splits.forEach(function (sp) {
          var era = numOr(sp.stat && sp.stat.era);
          if (era !== null && sp.team) map[sp.team.id] = era;
        });
        return map;
      })
      .catch(function () { return {}; });
  }
  function leagueBullpenEra(map) {
    var vals = Object.keys(map || {}).map(function (id) { return map[id]; }).filter(function (v) { return isFinite(v) && v > 0; });
    return vals.length ? vals.reduce(function (a, b) { return a + b; }, 0) / vals.length : LEAGUE_ERA;
  }

  // one range-schedule call covers every team's recent first-inning record
  // and full-game runs scored/allowed (feeds the game-total model)
  function fetchFirstInningRates() {
    var end = new Date(); end.setDate(end.getDate() - 1);
    var start = new Date(); start.setDate(start.getDate() - 25);
    var url = "https://statsapi.mlb.com/api/v1/schedule?sportId=1&startDate=" + toISODate(start) +
      "&endDate=" + toISODate(end) + "&hydrate=linescore";
    return fetchJson(url).then(function (data) {
      var byTeam = {}; // teamId -> chronological [{scored, allowed, rs, ra}]
      (data.dates || []).forEach(function (d) {
        (d.games || []).forEach(function (g) {
          if (!(g.status && g.status.abstractGameState === "Final")) return;
          var inn1 = g.linescore && g.linescore.innings && g.linescore.innings[0];
          if (!inn1 || !inn1.away || !inn1.home) return;
          var aRuns = Number(inn1.away.runs) > 0, hRuns = Number(inn1.home.runs) > 0;
          var aId = g.teams.away.team.id, hId = g.teams.home.team.id;
          var aScore = Number(g.teams.away.score), hScore = Number(g.teams.home.score);
          if (!isFinite(aScore) || !isFinite(hScore)) aScore = hScore = null;
          (byTeam[aId] = byTeam[aId] || []).push({ scored: aRuns, allowed: hRuns, rs: aScore, ra: hScore });
          (byTeam[hId] = byTeam[hId] || []).push({ scored: hRuns, allowed: aRuns, rs: hScore, ra: aScore });
        });
      });
      var rates = {};
      Object.keys(byTeam).forEach(function (id) {
        var games = byTeam[id].slice(-15);
        if (games.length < 8) return;
        var off = 0, def = 0, rsSum = 0, raSum = 0, runN = 0;
        games.forEach(function (g) {
          if (g.scored) off++;
          if (g.allowed) def++;
          if (g.rs !== null) { rsSum += g.rs; raSum += g.ra; runN++; }
        });
        rates[id] = {
          n: games.length, off: off, def: def,
          offRate: off / games.length, defRate: def / games.length,
          rsAvg: runN ? rsSum / runN : null,
          raAvg: runN ? raSum / runN : null,
        };
      });
      // league-wide averages used as the shrinkage prior below — derived from
      // the same fetch so it tracks the current run-scoring environment rather
      // than a hardcoded guess
      var ids = Object.keys(rates);
      var lo = 0, ld = 0, lrs = 0, lra = 0, rn = 0;
      ids.forEach(function (id) {
        var r = rates[id];
        lo += r.offRate; ld += r.defRate;
        if (r.rsAvg !== null) { lrs += r.rsAvg; lra += r.raAvg; rn++; }
      });
      rates._league = ids.length ? {
        offRate: lo / ids.length, defRate: ld / ids.length,
        rsAvg: rn ? lrs / rn : null, raAvg: rn ? lra / rn : null,
      } : null;
      return rates;
    }).catch(function () { return {}; });
  }

  function fetchPitcherSeasonStats(ids, season) {
    if (!ids.length) return Promise.resolve({});
    var url = "https://statsapi.mlb.com/api/v1/people?personIds=" + ids.join(",") +
      "&hydrate=stats(group=[pitching],type=[season])";
    return fetchJson(url).then(function (d) {
      var map = {};
      (d.people || []).forEach(function (p) {
        var splits = p.stats && p.stats[0] && p.stats[0].splits;
        var st = (splits && splits[0] && splits[0].stat) || {};
        st._hand = p.pitchHand ? p.pitchHand.code : null; // L/R, for the checklist platoon row
        map[p.id] = st;
      });
      return map;
    }).catch(function () { return {}; });
  }

  function fetchPitcherFirstInning(id, season) {
    return fetchJson("https://statsapi.mlb.com/api/v1/people/" + id +
        "/stats?stats=statSplits&group=pitching&sitCodes=i01&season=" + season)
      .then(function (d) {
        var sp = d.stats && d.stats[0] && d.stats[0].splits && d.stats[0].splits[0];
        return sp ? sp.stat : null;
      })
      .catch(function () { return null; });
  }

  // ---------- pitcher-vs-team / batter-vs-pitcher matchup signal ----------
  // A literal "ERA against this specific opponent" isn't exposed by the free
  // MLB Stats API — its vsTeam pitching split carries no earnedRuns/
  // inningsPitched field, only the batting line the pitcher has allowed. That
  // batting-average-against line is used instead (arguably the more direct
  // matchup number anyway) and blended with the flip side: the team's
  // currently-posted top-3 hitters' own career average against this exact
  // starter (vsPlayerTotal). Either half needs a real at-bat sample or it's
  // dropped rather than fed in noisy. No season param is passed to either
  // call — MLB Stats API silently scopes "Total" splits to a single season
  // when one is present, which would collapse a multi-year matchup down to
  // however many times these two have met this year alone.
  var MATCHUP_MIN_AB = 15;
  function fetchPitcherVsTeam(pitcherId, teamId) {
    if (!pitcherId || !teamId) return Promise.resolve(null);
    return fetchJson("https://statsapi.mlb.com/api/v1/people/" + pitcherId +
        "/stats?stats=vsTeamTotal&opposingTeamId=" + teamId + "&group=pitching")
      .then(function (d) {
        var sp = d.stats && d.stats[0] && d.stats[0].splits && d.stats[0].splits[0];
        var st = sp && sp.stat;
        var ab = st && numOr(st.atBats);
        return st && ab >= MATCHUP_MIN_AB ? { avg: numOr(st.avg), atBats: ab } : null;
      })
      .catch(function () { return null; });
  }
  function fetchHittersVsPitcher(batterIds, pitcherId) {
    if (!batterIds || !batterIds.length || !pitcherId) return Promise.resolve(null);
    var url = "https://statsapi.mlb.com/api/v1/people?personIds=" + batterIds.join(",") +
      "&hydrate=stats(group=[hitting],type=[vsPlayerTotal],opposingPlayerId=" + pitcherId + ")";
    return fetchJson(url).then(function (d) {
      var ab = 0, hits = 0;
      (d.people || []).forEach(function (p) {
        var sp = p.stats && p.stats[0] && p.stats[0].splits && p.stats[0].splits[0];
        var st = sp && sp.stat;
        if (!st) return;
        var a = numOr(st.atBats);
        if (a) { ab += a; hits += numOr(st.hits) || 0; }
      });
      return ab >= MATCHUP_MIN_AB ? { avg: hits / ab, atBats: ab } : null;
    }).catch(function () { return null; });
  }
  // AB-weighted blend of the pitcher's own history vs this team with this
  // lineup's own history vs this pitcher; one lopsided sample is capped so it
  // can't dominate the other
  function combineMatchup(pitcherLine, hitterLine) {
    var ab = 0, weighted = 0;
    [pitcherLine, hitterLine].forEach(function (m) {
      if (!m) return;
      var w = Math.min(m.atBats, 100);
      ab += w; weighted += m.avg * w;
    });
    return ab > 0 ? { avg: weighted / ab, atBats: ab } : null;
  }

  // ---------- NRFI 15-item advanced checklist ----------
  // Items that need Statcast (Hard Hit%, Barrel%, xwOBA), a live NRFI market,
  // or umpire zone data have no free API source: they render as "no data" and
  // the score renormalizes over the weight that could actually be evaluated.
  var YRFI_PARKS = ["Coors Field", "Great American Ball Park", "Yankee Stadium"];
  var NRFI_PARKS = ["Petco Park", "Oracle Park", "T-Mobile Park"];

  var ops7Cache = {};
  function fetchTeam7dOps(teamId, season) {
    if (!teamId) return Promise.resolve(null);
    if (!ops7Cache[teamId]) {
      var end = new Date(); end.setDate(end.getDate() - 1);
      var start = new Date(); start.setDate(start.getDate() - 7);
      ops7Cache[teamId] = fetchJson("https://statsapi.mlb.com/api/v1/teams/" + teamId +
          "/stats?stats=byDateRange&group=hitting&startDate=" + toISODate(start) +
          "&endDate=" + toISODate(end) + "&season=" + season)
        .then(function (d) {
          var sp = d.stats && d.stats[0] && d.stats[0].splits && d.stats[0].splits[0];
          var o = sp && sp.stat ? Number(sp.stat.ops) : NaN;
          return isFinite(o) ? o : null;
        })
        .catch(function () { return null; });
    }
    return ops7Cache[teamId];
  }

  function fetchGameWeather(pk) {
    return fetchJson("https://statsapi.mlb.com/api/v1.1/game/" + pk +
        "/feed/live?fields=gameData,weather,condition,temp,wind")
      .then(function (d) { return (d.gameData && d.gameData.weather) || null; })
      .catch(function () { return null; });
  }

  // posted lineup top-3 + home-plate umpire come from the same boxscore call
  function fetchBoxscoreExtras(pk) {
    return fetchJson("https://statsapi.mlb.com/api/v1/game/" + pk + "/boxscore")
      .then(function (d) {
        function top3(side) {
          var bo = d.teams && d.teams[side] && d.teams[side].battingOrder;
          return (bo && bo.length >= 3) ? bo.slice(0, 3) : [];
        }
        var hp = (d.officials || []).find(function (o) {
          return o.officialType === "Home Plate" && o.official;
        });
        return { awayTop3: top3("away"), homeTop3: top3("home"), umpire: hp ? hp.official.fullName : null };
      })
      .catch(function () { return { awayTop3: [], homeTop3: [], umpire: null }; });
  }

  function fetchTop3Hitters(ids) {
    if (!ids.length) return Promise.resolve({});
    var base = "https://statsapi.mlb.com/api/v1/people?personIds=" + ids.join(",");
    return Promise.all([
      fetchJson(base + "&hydrate=stats(group=[hitting],type=[season])").catch(function () { return null; }),
      fetchJson(base + "&hydrate=stats(group=[hitting],type=[statSplits],sitCodes=[vl,vr])").catch(function () { return null; }),
    ]).then(function (r) {
      var map = {};
      function ensure(id) { return (map[id] = map[id] || { season: null, vl: null, vr: null }); }
      if (r[0]) (r[0].people || []).forEach(function (p) {
        var sp = p.stats && p.stats[0] && p.stats[0].splits && p.stats[0].splits[0];
        if (sp) ensure(p.id).season = sp.stat;
      });
      if (r[1]) (r[1].people || []).forEach(function (p) {
        ((p.stats && p.stats[0] && p.stats[0].splits) || []).forEach(function (sp) {
          var c = sp.split && sp.split.code;
          if (c === "vl") ensure(p.id).vl = sp.stat;
          else if (c === "vr") ensure(p.id).vr = sp.stat;
        });
      });
      return map;
    });
  }

  function collectChecklistData(g, season) {
    var ppA = g.teams.away.probablePitcher, ppH = g.teams.home.probablePitcher;
    var awayTeamId = g.teams.away.team.id, homeTeamId = g.teams.home.team.id;
    return Promise.all([
      fetchGameWeather(g.gamePk),
      fetchBoxscoreExtras(g.gamePk),
      fetchTeam7dOps(awayTeamId, season),
      fetchTeam7dOps(homeTeamId, season),
      fetchPitcherVsTeam(ppA && ppA.id, homeTeamId), // away starter's career line vs the home team
      fetchPitcherVsTeam(ppH && ppH.id, awayTeamId), // home starter's career line vs the away team
    ]).then(function (r) {
      var box = r[1];
      return Promise.all([
        fetchTop3Hitters(box.awayTop3.concat(box.homeTop3)),
        fetchHittersVsPitcher(box.homeTop3, ppA && ppA.id), // home hitters' career avg vs the away starter
        fetchHittersVsPitcher(box.awayTop3, ppH && ppH.id), // away hitters' career avg vs the home starter
      ]).then(function (r2) {
        return {
          weather: r[0], box: box, ops7: { away: r[2], home: r[3] }, hitters: r2[0],
          matchup: {
            // home team's offense vs today's away starter: his own history + this lineup's own history
            homeOff: combineMatchup(r[4], r2[1]),
            // away team's offense vs today's home starter
            awayOff: combineMatchup(r[5], r2[2]),
          },
        };
      });
    });
  }

  function numOr(v) { var n = Number(v); return isFinite(n) ? n : null; }
  function rateOf(n, d) { n = Number(n); d = Number(d); return d > 0 && isFinite(n) ? n / d : null; }
  function ops3(v) { return v === null || v === undefined ? "-" : v.toFixed(3).replace(/^0/, ""); }
  function parseWind(w) {
    if (!w) return null;
    var m = String(w).match(/(\d+(?:\.\d+)?)\s*mph/i);
    return { mph: m ? Number(m[1]) : null, out: /out to/i.test(String(w)), in: /in from/i.test(String(w)) };
  }

  // ---------- park & weather run environment ----------
  // YRFI_PARKS / NRFI_PARKS were already curated for the checklist display but
  // never actually moved the NRFI/大小分 numbers — they only rendered a label
  // and (Coors only) fed the veto gate. That's a real gap: a park the site
  // itself flags as "hitter friendly" had zero effect on the estimated
  // probability. These wire that same signal into both models as modest,
  // deliberately conservative nudges (Coors' altitude effect is the one
  // well-established outlier, so it gets the largest adjustment).
  function parkTotalRunAdj(venue) {
    if (!venue) return 0;
    if (venue === "Coors Field") return 1.4;
    if (YRFI_PARKS.indexOf(venue) !== -1) return 0.5;
    if (NRFI_PARKS.indexOf(venue) !== -1) return -0.4;
    return 0;
  }
  function parkFirstInningAdj(venue) {
    if (!venue) return 0;
    if (venue === "Coors Field") return -0.06;
    if (YRFI_PARKS.indexOf(venue) !== -1) return -0.03;
    if (NRFI_PARKS.indexOf(venue) !== -1) return 0.025;
    return 0;
  }
  function weatherTotalRunAdj(w) {
    if (!w) return 0;
    var temp = numOr(w.temp), wind = parseWind(w.wind), adj = 0;
    if (temp !== null && temp >= 95) adj += 0.3;
    if (wind && wind.mph !== null && wind.mph > 12) {
      if (wind.out) adj += 0.5;
      else if (wind.in) adj -= 0.4;
    }
    return adj;
  }
  function weatherFirstInningAdj(w) {
    if (!w) return 0;
    var temp = numOr(w.temp), wind = parseWind(w.wind), adj = 0;
    if (temp !== null && temp >= 95) adj -= 0.02;
    if (wind && wind.mph !== null && wind.mph > 12) {
      if (wind.out) adj -= 0.03;
      else if (wind.in) adj += 0.02;
    }
    return adj;
  }

  function buildChecklist(ctx) {
    var rows = [], gate = [];
    function addRow(stars, name, weight, value, status, note) {
      rows.push({ stars: stars, name: name, weight: weight, value: value, status: status, note: note || "" });
    }
    var sides = [
      { tag: "客", pp: ctx.ppA, p1: ctx.aP1 },
      { tag: "主", pp: ctx.ppH, p1: ctx.hP1 },
    ];
    // evaluates both starters; row passes only when every side with data passes
    function bothStarters(fn) {
      var any = false, fail = false;
      sides.forEach(function (s) {
        var r = s.p1 ? fn(s.p1) : null;
        if (r === null || r === undefined) return;
        any = true;
        if (!r) fail = true;
      });
      return any ? (fail ? "fail" : "pass") : "na";
    }
    function i01Ops(st) {
      if (!st) return null;
      var o = numOr(st.ops);
      if (o !== null) return o;
      var ob = numOr(st.obp), sl = numOr(st.slg);
      return ob !== null && sl !== null ? ob + sl : null;
    }

    // "直接 PASS" gate conditions we have data for (>=2 hits vetoes NRFI)
    sides.forEach(function (s) {
      if (!s.p1) return;
      var bb = rateOf(s.p1.baseOnBalls, s.p1.battersFaced);
      if (bb !== null && bb > 0.09) gate.push(s.tag + "隊先發首局 BB% " + (bb * 100).toFixed(1) + "% > 9%");
      var o = i01Ops(s.p1);
      if (o !== null && o > 0.78) gate.push(s.tag + "隊先發首局被打 OPS " + ops3(o) + " > .780");
    });
    if (!ctx.ppA || !ctx.ppH) gate.push("有球隊未公布正式先發(疑似牛棚車輪戰)");

    function fmt1(st) { return st ? (st.era || "-") + " / " + (st.whip || "-") + " / " + (st.avg || "-") : "無分項"; }
    addRow("★★★★★", "① 先發首局 ERA / WHIP / 被打擊率", 20,
      "客 " + esc(fmt1(ctx.aP1)) + ";主 " + esc(fmt1(ctx.hP1)),
      bothStarters(function (st) {
        var era = numOr(st.era), whip = numOr(st.whip), avg = numOr(st.avg);
        if (era === null && whip === null && avg === null) return null;
        return era !== null && era < 2.5 && whip !== null && whip < 1.1 && avg !== null && avg < 0.22;
      }),
      "目標 ERA<2.50、WHIP<1.10、BAA<.220,兩位先發皆須達標");

    function fmt2(st) {
      var o = i01Ops(st), k = st ? rateOf(st.strikeOuts, st.battersFaced) : null;
      return o === null ? "無分項" : "OPS " + ops3(o) + (k !== null ? "、K% " + (k * 100).toFixed(0) + "%" : "");
    }
    addRow("★★★★★", "② 第一輪打者壓制(以首局分項近似 TTO1)", 15,
      "客 " + fmt2(ctx.aP1) + ";主 " + fmt2(ctx.hP1),
      bothStarters(function (st) { var o = i01Ops(st); return o === null ? null : o < 0.65; }),
      "目標被打 OPS<.650;xwOBA 需 Statcast,無免費來源");

    function fmt3(st) { var b = st ? rateOf(st.baseOnBalls, st.battersFaced) : null; return b === null ? "無分項" : (b * 100).toFixed(1) + "%"; }
    addRow("★★★★★", "③ 先發首局保送率 BB%", 10,
      "客 " + fmt3(ctx.aP1) + ";主 " + fmt3(ctx.hP1),
      bothStarters(function (st) { var b = rateOf(st.baseOnBalls, st.battersFaced); return b === null ? null : b < 0.07; }),
      "目標 <7%;>9% 列入直接 PASS 條件");

    addRow("★★★★★", "④ Hard Hit%", 10, "—", "na", "需 Statcast(Baseball Savant),免費 API 未提供,不計分");
    addRow("★★★★★", "⑤ Barrel%", 10, "—", "na", "需 Statcast(Baseball Savant),免費 API 未提供,不計分");

    function top3Avg(ids, key) {
      var vals = [];
      (ids || []).forEach(function (id) {
        var h = ctx.hitters[id];
        var o = h && h[key] ? numOr(h[key].ops) : null;
        if (o !== null) vals.push(o);
      });
      return vals.length ? vals.reduce(function (a, b) { return a + b; }, 0) / vals.length : null;
    }
    // fails when either team's evaluable value crosses the limit
    function twoTeamStatus(a, h, limit) {
      if ((a === null || a === undefined) && (h === null || h === undefined)) return "na";
      return (a !== null && a !== undefined && a >= limit) || (h !== null && h !== undefined && h >= limit) ? "fail" : "pass";
    }
    var a6 = top3Avg(ctx.box.awayTop3, "season"), h6 = top3Avg(ctx.box.homeTop3, "season");
    addRow("★★★★", "⑥ 前三棒 OPS(打線公布後,球季值近似)", 10,
      a6 === null && h6 === null ? "打線未公布" : "客 " + ops3(a6) + ";主 " + ops3(h6),
      twoTeamStatus(a6, h6, 0.85),
      "≥.850 視為危險;近 15 場逐場資料無免費來源,以球季值近似");
    if (a6 !== null && a6 > 0.9) gate.push("客隊前三棒 OPS " + ops3(a6) + " > .900");
    if (h6 !== null && h6 > 0.9) gate.push("主隊前三棒 OPS " + ops3(h6) + " > .900");

    var aKey = ctx.hHand === "L" ? "vl" : ctx.hHand === "R" ? "vr" : null; // away hitters face the home starter
    var hKey = ctx.aHand === "L" ? "vl" : ctx.aHand === "R" ? "vr" : null;
    var a7 = aKey ? top3Avg(ctx.box.awayTop3, aKey) : null;
    var h7 = hKey ? top3Avg(ctx.box.homeTop3, hKey) : null;
    addRow("★★★★", "⑦ 前三棒對今日先發左右投 OPS", 5,
      a7 === null && h7 === null
        ? (a6 === null && h6 === null ? "打線未公布" : "無左右投分項")
        : "客 vs" + (ctx.hHand || "?") + " " + ops3(a7) + ";主 vs" + (ctx.aHand || "?") + " " + ops3(h7),
      twoTeamStatus(a7, h7, 0.85), "≥.850 視為危險");

    addRow("★★★★", "⑧ 近 15 場首局得分率", 5,
      "客 " + Math.round(ctx.aFi.offRate * 100) + "%;主 " + Math.round(ctx.hFi.offRate * 100) + "%",
      ctx.aFi.offRate < 0.35 && ctx.hFi.offRate < 0.35 ? "pass" : "fail", "兩隊皆 <35% 為佳");
    addRow("★★★★", "⑨ 近 15 場首局失分率", 5,
      "客 " + Math.round(ctx.aFi.defRate * 100) + "%;主 " + Math.round(ctx.hFi.defRate * 100) + "%",
      ctx.aFi.defRate < 0.35 && ctx.hFi.defRate < 0.35 ? "pass" : "fail", "兩隊皆 <35% 為佳");

    var o7a = ctx.ops7.away, o7h = ctx.ops7.home;
    addRow("★★★★", "⑩ 近 7 天團隊 OPS", 5,
      (o7a === null || o7a === undefined) && (o7h === null || o7h === undefined)
        ? "無資料" : "客 " + ops3(o7a) + ";主 " + ops3(o7h),
      twoTeamStatus(o7a, o7h, 0.78), "≥.780 代表打線火熱;>.850 列入直接 PASS 條件");
    if (o7a !== null && o7a !== undefined && o7a > 0.85) gate.push("客隊近 7 天 OPS " + ops3(o7a) + " > .850");
    if (o7h !== null && o7h !== undefined && o7h > 0.85) gate.push("主隊近 7 天 OPS " + ops3(o7h) + " > .850");

    var park = ctx.venue || "";
    var parkLean = YRFI_PARKS.indexOf(park) !== -1 ? "yrfi" : NRFI_PARKS.indexOf(park) !== -1 ? "nrfi" : "mid";
    addRow("★★★", "⑪ 球場", 2,
      esc(park || "-") + (parkLean === "yrfi" ? "(打者友善)" : parkLean === "nrfi" ? "(投手友善)" : "(中性)"),
      park ? (parkLean === "yrfi" ? "fail" : "pass") : "na",
      "Coors/大美國/洋基偏 YRFI;Petco/Oracle/T-Mobile 偏 NRFI");
    if (park === "Coors Field") gate.push("球場為 Coors Field");

    var w = ctx.weather, wind = w ? parseWind(w.wind) : null;
    if (!w || (!w.temp && !w.wind)) {
      addRow("★★★", "⑫ 天氣(溫度/風向/風速)", 1, "尚未提供", "na", "臨近開賽才會有資料");
    } else {
      var temp = numOr(w.temp);
      var hot = temp !== null && temp >= 95;
      var windOut = wind && wind.mph !== null && wind.mph > 12 && wind.out;
      addRow("★★★", "⑫ 天氣(溫度/風向/風速)", 1,
        esc((w.condition ? w.condition + "、" : "") + (w.temp ? w.temp + "°F、" : "") + (w.wind || "")),
        hot || windOut ? "fail" : "pass", "≥95°F 或風速 >12mph 吹向外野視為 YRFI 助力");
      if (windOut) gate.push("風速 " + wind.mph + " mph 且吹向外野");
    }

    addRow("★★★", "⑬ 主審", 1, ctx.box.umpire ? esc(ctx.box.umpire) : "未公布", "na",
      "好球帶傾向無免費數據源,僅列名供人工查證,不計分");
    addRow("★★★", "⑭ NRFI 盤口", 1,
      ctx.nrOdds
        ? esc("NRFI(Under)" + ctx.nrOdds.under + " / YRFI(Over)" + ctx.nrOdds.over + "(" + ctx.nrOdds.book + ")")
        : "—",
      "na",
      ctx.nrOdds ? "已取得即時賠率;開盤至今的變動歷史無免費來源,不計分"
                 : "免費賠率源無 NRFI 盤;可於頁首設定 The Odds API 金鑰取得,不計分");
    addRow("★★★", "⑮ 先發打線", 0,
      ctx.box.awayTop3.length || ctx.box.homeTop3.length ? "已公布(見⑥⑦)" : "未公布(開賽前 1–3 小時)",
      "na", "新人/輪休異動需人工判斷,不計分");

    var passW = 0, evalW = 0;
    rows.forEach(function (r) {
      if (r.status === "pass") { passW += r.weight; evalW += r.weight; }
      else if (r.status === "fail") evalW += r.weight;
    });
    return {
      rows: rows,
      score: evalW > 0 ? Math.round((passW / evalW) * 100) : null,
      evalW: evalW,
      gate: gate,
    };
  }

  function checklistHtml(cl) {
    var icon = { pass: ["✓ 通過", "ok"], fail: ["✗ 未過", "bad"], na: ["—", "na"] };
    var trs = cl.rows.map(function (r) {
      var ic = icon[r.status];
      return '<tr><td class="cl-stars">' + r.stars + '</td>' +
        '<td>' + r.name + (r.note ? '<div class="cl-note">' + r.note + '</div>' : '') + '</td>' +
        '<td>' + r.value + '</td>' +
        '<td class="cl-status ' + ic[1] + '">' + ic[0] + '</td></tr>';
    }).join("");
    return '<details class="pick-checklist" open><summary>📋 NRFI 15 項進階檢查表' +
      (cl.score !== null ? ' · NRFI 友善度 <b>' + cl.score + '</b>/100(可評估權重 ' + cl.evalW + '%)' : '') +
      (cl.gate.length ? ' · <span class="cl-gate-tag">⚠ 直接 PASS 條件 ' + cl.gate.length + ' 項</span>' : '') +
      '</summary>' +
      '<div class="table-wrap cl-wrap"><table class="cl-table">' +
      '<tr><th>權重</th><th>檢查項</th><th>本場數值</th><th>判定</th></tr>' + trs + '</table></div>' +
      (cl.gate.length
        ? '<p class="cl-gate">🚫 直接 PASS 條件命中:' + cl.gate.join(";") + "。" +
          (cl.gate.length >= 2 ? "已達 2 項門檻,依規則不下 NRFI。" : "未達 2 項門檻。") + '</p>'
        : '') +
      '</details>';
  }

  function l10Rate(rec) {
    if (!rec || !rec.lastTen) return null;
    var parts = rec.lastTen.split("-");
    var w = Number(parts[0]), l = Number(parts[1]);
    return (w + l) > 0 ? w / (w + l) : null;
  }

  // same blend the game-detail modal uses: record share + last-10 share,
  // starter-ERA nudge, conditional home advantage (only when the home team
  // actually plays like a home team — home win% > 60% — rather than crediting
  // every home team with a bump regardless of whether it's earned)
  function mlbModelHome(aRec, hRec, aEra, hEra, awayOff, homeOff, aBullEra, hBullEra) {
    if (!aRec || !hRec) return null;
    var comps = [];
    if (aRec.pct + hRec.pct > 0) comps.push(hRec.pct / (aRec.pct + hRec.pct));
    var aL10 = l10Rate(aRec), hL10 = l10Rate(hRec);
    if (aL10 !== null && hL10 !== null && aL10 + hL10 > 0) comps.push(hL10 / (aL10 + hL10));
    if (!comps.length) return null;
    var m = comps.reduce(function (x, y) { return x + y; }, 0) / comps.length;
    if (isFinite(aEra) && isFinite(hEra)) m += clampNum((aEra - hEra) * 0.04, -0.06, 0.06);
    // each side's offense-vs-today's-opposing-starter matchup average — home
    // hitters crushing the away starter's history (or vice versa) nudges win
    // probability the same direction
    var homeAvg = homeOff ? homeOff.avg : LEAGUE_AVG_BA;
    var awayAvg = awayOff ? awayOff.avg : LEAGUE_AVG_BA;
    m += clampNum((homeAvg - awayAvg) * 0.6, -0.05, 0.05);
    // bullpen ERA: a smaller, secondary nudge — the starter still throws the
    // bulk of a team's innings, so this weighs less than the starter-ERA term
    if (isFinite(aBullEra) && isFinite(hBullEra)) m += clampNum((aBullEra - hBullEra) * 0.03, -0.045, 0.045);
    if (hRec.homeWinPct !== null && hRec.homeWinPct !== undefined && hRec.homeWinPct > 0.6) m += 0.035;
    return clampNum(m, 0.05, 0.95);
  }

  // MLB/NBA schedule dates follow the US Eastern game day, which lags Taiwan
  // by 12-13h — using the local date would fetch tomorrow's slate all morning
  function usTodayISO() {
    return new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(new Date());
  }

  function collectMlb() {
    var today = usTodayISO();
    var season = Number(today.slice(0, 4));
    var schedP = fetchJson("https://statsapi.mlb.com/api/v1/schedule?sportId=1&date=" + today + "&hydrate=probablePitcher,team");
    var espnP = fetchJson("https://site.api.espn.com/apis/site/v2/sports/baseball/mlb/scoreboard?dates=" + today.replace(/-/g, ""))
      .then(function (data) { return { ml: buildEspnMlMap(data), tot: buildEspnTotMap(data), spread: buildEspnSpreadMap(data) }; })
      .catch(function () { return { ml: {}, tot: {}, spread: {} }; });

    return Promise.all([schedP, fetchMlbStandings(season), espnP, fetchFirstInningRates(), fetchPlaysportMlMap(), fetchBullpenEraMap(season)]).then(function (res) {
      var sched = res[0], standings = res[1], mlMap = res[2].ml, totMap = res[2].tot, spreadMap = res[2].spread, fiRates = res[3], psMap = res[4], bullpenMap = res[5];
      var dynLeagueBullEra = leagueBullpenEra(bullpenMap);
      var games = [];
      (sched.dates || []).forEach(function (d) { games = games.concat(d.games || []); });
      games = games.filter(function (g) {
        return g.status && g.status.abstractGameState === "Preview" &&
          !/Postponed|Suspended|Cancelled/i.test(g.status.detailedState || "");
      });

      var pitcherIds = [];
      games.forEach(function (g) {
        ["away", "home"].forEach(function (s) {
          var pp = g.teams[s].probablePitcher;
          if (pp && pitcherIds.indexOf(pp.id) === -1) pitcherIds.push(pp.id);
        });
      });

      return Promise.all([
        fetchPitcherSeasonStats(pitcherIds, season),
        Promise.all(pitcherIds.map(function (id) { return fetchPitcherFirstInning(id, season); })),
        Promise.all(games.map(function (g) {
          return collectChecklistData(g, season).catch(function () { return null; });
        })),
        fetchNrfiOddsMap(games),
      ]).then(function (pres) {
        var seasonStats = pres[0];
        var fiByPitcher = {};
        pitcherIds.forEach(function (id, i) { fiByPitcher[id] = pres[1][i]; });
        var extras = pres[2];
        var nrfiOddsMap = pres[3];
        var dynLeagueEra = leagueEraFromPool(seasonStats, pitcherIds);
        var fiLeague = fiRates._league;

        var candidates = [];
        games.forEach(function (g, gi) {
          var away = g.teams.away.team, home = g.teams.home.team;
          var aRec = standings[away.id], hRec = standings[home.id];
          var ppA = g.teams.away.probablePitcher, ppH = g.teams.home.probablePitcher;
          var aSt = ppA ? (seasonStats[ppA.id] || {}) : {};
          var hSt = ppH ? (seasonStats[ppH.id] || {}) : {};
          var matchup = (extras[gi] && extras[gi].matchup) || {};
          var aBullEra = bullpenMap[away.id], hBullEra = bullpenMap[home.id];
          var base = {
            league: "MLB",
            away: away.name, home: home.name,
            start: g.gameDate,
          };

          // -- moneyline (獨贏) --
          var ml = mlMap[away.name + "|" + home.name];
          if (!ml) {
            // ESPN not posted yet: fall back to playsport (台灣運彩), but only
            // when its listed game start matches this game (it lists the
            // current Taiwan day only, which can be yesterday's US slate)
            var ps = psMap[away.name + "|" + home.name];
            if (ps && (!ps.ts || Math.abs(ps.ts - new Date(g.gameDate).getTime()) < 6 * 3600 * 1000)) ml = ps;
          }
          var fair = ml ? fairProbs(ml.a.cur, ml.h.cur) : null;
          var modelH = mlbModelHome(aRec, hRec, Number(aSt.era), Number(hSt.era), matchup.awayOff, matchup.homeOff, aBullEra, hBullEra);
          if (modelH !== null) {
            var pickHome, edge, prob, market, price;
            if (fair) {
              // market available: pick the side the model gives the higher win probability
              var edgeH = modelH - fair.home, edgeA = (1 - modelH) - fair.away;
              pickHome = modelH >= 0.5;
              edge = pickHome ? edgeH : edgeA;
              prob = pickHome ? modelH : 1 - modelH;
              market = pickHome ? fair.home : fair.away;
              price = String(pickHome ? ml.h.cur : ml.a.cur) +
                (ml.src === "playsport" ? "(運彩換算)" : "");
            } else {
              // odds not posted yet: still surface the model favourite's win prob
              pickHome = modelH >= 0.5;
              prob = pickHome ? modelH : 1 - modelH;
              market = impliedProb(NRFI_PRICE); // -110 reference breakeven ~52.4%
              edge = prob - market;
              price = NRFI_PRICE + "(參考,賠率未開)";
            }
            var reasons = [];
            if (aRec && hRec) {
              reasons.push("戰績:客 " + aRec.wins + "-" + aRec.losses + "(近十場 " + (aRec.lastTen || "-") +
                "),主 " + hRec.wins + "-" + hRec.losses + "(近十場 " + (hRec.lastTen || "-") + ")。");
            }
            if (ppA && ppH) {
              reasons.push("先發:" + esc(ppA.fullName) + " ERA " + esc(aSt.era || "-") +
                " vs " + esc(ppH.fullName) + " ERA " + esc(hSt.era || "-") + "。");
            }
            if (ppA && ppH && (matchup.awayOff || matchup.homeOff)) {
              var mlMatchupParts = [];
              if (matchup.homeOff) mlMatchupParts.push("主隊打線對 " + esc(ppA.fullName) + " 生涯合計打擊率 " +
                ops3(matchup.homeOff.avg) + "(" + matchup.homeOff.atBats + " 打數)");
              if (matchup.awayOff) mlMatchupParts.push("客隊打線對 " + esc(ppH.fullName) + " 生涯合計打擊率 " +
                ops3(matchup.awayOff.avg) + "(" + matchup.awayOff.atBats + " 打數)");
              reasons.push("先發對戰數據(該先發對戰該隊生涯 + 該隊打者對戰該先發生涯,合併計算):" +
                mlMatchupParts.join(";") + "。");
            }
            if (isFinite(aBullEra) && isFinite(hBullEra)) {
              reasons.push("牛棚 ERA:客 " + aBullEra.toFixed(2) + " vs 主 " + hBullEra.toFixed(2) +
                "(聯盟牛棚平均 " + dynLeagueBullEra.toFixed(2) + ")。");
            }
            var edgeStr = "<b>" + (edge >= 0 ? "+" : "") + (edge * 100).toFixed(1) + "%</b>";
            if (fair) {
              reasons.push("模型獨贏勝率 <b>" + pctStr(prob) + "</b> vs 市場中性機率 " +
                pctStr(market) + ",優勢 " + edgeStr + "。");
              if (ml.src === "playsport") {
                reasons.push("賠率來源:ESPN 尚未開盤,取玩運彩(台灣運彩)獨贏賠率換算為美式水位並去除抽水。");
              }
              var mv = mlMoveNote(ml, pickHome, away.name, home.name);
              if (mv) reasons.push(mv);
            } else {
              reasons.push("模型獨贏勝率 <b>" + pctStr(prob) + "</b>;市場賠率尚未開出,暫以 -110 參考水位(" +
                pctStr(market) + ")計優勢 " + edgeStr + ",開盤後請以實際賠率為準。");
            }
            candidates.push(Object.assign({}, base, {
              type: "ml",
              pick: (pickHome ? home.name + " 主勝" : away.name + " 客勝"),
              price: price,
              prob: prob,
              market: market,
              edge: edge,
              reasons: reasons,
            }));

            // -- 讓分(Run Line,MLB 慣例 ±1.5)--
            // No independent run-differential model is built; the moneyline
            // win probability above is projected onto a margin distribution
            // (see homeCoverProb) to price the run line off the same inputs.
            var sp = spreadMap[away.name + "|" + home.name];
            if (sp) {
              var pHomeCover = homeCoverProb(modelH, sp.home.line, TOTAL_SD);
              var beHomeSp = impliedProb(sp.home.price), beAwaySp = impliedProb(sp.away.price);
              if (beHomeSp !== null && beAwaySp !== null) {
                var pickHomeSp = pHomeCover >= 0.5;
                var probSp = pickHomeSp ? pHomeCover : 1 - pHomeCover;
                var beSp = pickHomeSp ? beHomeSp : beAwaySp;
                var lineSp = pickHomeSp ? sp.home.line : sp.away.line;
                var priceSp = pickHomeSp ? sp.home.price : sp.away.price;
                var reasonsSp = [
                  "模型獨贏勝率 <b>" + pctStr(modelH) + "</b>(主)反推期望分差(常態分布近似,標準差取自大小分模型的總分標準差,詳見程式註解),估計" +
                    (pickHomeSp ? "主" : "客") + "隊讓分 " + (lineSp >= 0 ? "+" : "") + lineSp +
                    " 覆蓋機率 <b>" + pctStr(probSp) + "</b>。",
                  "以 " + esc(priceSp) + " 計損益兩平 " + pctStr(beSp) + ",優勢 <b>" +
                    ((probSp - beSp) >= 0 ? "+" : "") + ((probSp - beSp) * 100).toFixed(1) + "%</b>。",
                ];
                candidates.push(Object.assign({}, base, {
                  type: "spread",
                  pick: (pickHomeSp ? home.name : away.name) + " " + (lineSp >= 0 ? "+" : "") + lineSp,
                  price: String(priceSp),
                  prob: probSp,
                  market: beSp,
                  edge: probSp - beSp,
                  reasons: reasonsSp,
                }));
              }
            }
          }

          // -- NRFI / YRFI --
          var aFi = fiRates[away.id], hFi = fiRates[home.id];
          if (aFi && hFi) {
            // shrink each side's small-sample rate toward the league-wide mean
            // before feeding the probability model; the raw rates still drive
            // every "客隊近 N 場…" sentence below so the reasoning stays honest
            // about what was actually observed
            var aOffM = shrinkRate(aFi.offRate, aFi.n, fiLeague && fiLeague.offRate);
            var hDefM = shrinkRate(hFi.defRate, hFi.n, fiLeague && fiLeague.defRate);
            var hOffM = shrinkRate(hFi.offRate, hFi.n, fiLeague && fiLeague.offRate);
            var aDefM = shrinkRate(aFi.defRate, aFi.n, fiLeague && fiLeague.defRate);
            var pA = (aOffM + hDefM) / 2;
            var pH = (hOffM + aDefM) / 2;
            var nrfi = (1 - pA) * (1 - pH);
            var reasons2 = [
              "客隊近 " + aFi.n + " 場首局得分 " + aFi.off + " 次(" + Math.round(aFi.offRate * 100) +
                "%),主隊首局失分 " + hFi.def + " 次(" + Math.round(hFi.defRate * 100) + "%)。",
              "主隊近 " + hFi.n + " 場首局得分 " + hFi.off + " 次(" + Math.round(hFi.offRate * 100) +
                "%),客隊首局失分 " + aFi.def + " 次(" + Math.round(aFi.defRate * 100) + "%)。",
            ];
            // starters with extreme first-inning ERA nudge the estimate
            // (needs >= 8 first innings pitched, or the split ERA is too noisy)
            [[ppA, "客"], [ppH, "主"]].forEach(function (pair) {
              var pp = pair[0];
              var st = pp ? fiByPitcher[pp.id] : null;
              if (!pp || !st || !st.era) return;
              var era = Number(st.era), ip = Number(st.inningsPitched);
              if (!isFinite(era)) return;
              if (!isFinite(ip) || ip < 8) {
                reasons2.push(pair[1] + "隊先發 " + esc(pp.fullName) + " 首局 ERA " + esc(st.era) + "(僅 " + esc(st.inningsPitched || "-") + " 局,樣本不足不列入調整)。");
                return;
              }
              if (era <= 2.0) { nrfi += 0.03; reasons2.push(pair[1] + "隊先發 " + esc(pp.fullName) + " 首局 ERA 僅 " + esc(st.era) + "(" + esc(st.inningsPitched) + " 局),開局壓制力強(NRFI +3%)。"); }
              else if (era >= 6.0) { nrfi -= 0.03; reasons2.push(pair[1] + "隊先發 " + esc(pp.fullName) + " 首局 ERA 高達 " + esc(st.era) + "(" + esc(st.inningsPitched) + " 局),開局明顯不穩(NRFI −3%)。"); }
              else reasons2.push(pair[1] + "隊先發 " + esc(pp.fullName) + " 首局 ERA " + esc(st.era) + "。");
            });
            var venueName = g.venue && g.venue.name;
            var wx = extras[gi] && extras[gi].weather;
            var parkFiAdj = parkFirstInningAdj(venueName);
            var weatherFiAdj = weatherFirstInningAdj(wx);
            if (parkFiAdj) {
              nrfi += parkFiAdj;
              reasons2.push("球場「" + esc(venueName) + "」" + (parkFiAdj < 0 ? "偏打者向" : "偏投手向") +
                "(NRFI " + (parkFiAdj >= 0 ? "+" : "") + (parkFiAdj * 100).toFixed(1) + "%)。");
            }
            if (weatherFiAdj) {
              nrfi += weatherFiAdj;
              reasons2.push((weatherFiAdj < 0 ? "天氣條件(高溫或強風吹向外野)對進攻有利" : "強風吹向內野抑制打擊") +
                "(NRFI " + (weatherFiAdj >= 0 ? "+" : "") + (weatherFiAdj * 100).toFixed(1) + "%)。");
            }
            if (ppA && ppH && (matchup.awayOff || matchup.homeOff)) {
              var fiMatchupParts = [];
              if (matchup.homeOff) fiMatchupParts.push("主隊打線對客隊先發 " + esc(ppA.fullName) + " 生涯合計打擊率 " + ops3(matchup.homeOff.avg));
              if (matchup.awayOff) fiMatchupParts.push("客隊打線對主隊先發 " + esc(ppH.fullName) + " 生涯合計打擊率 " + ops3(matchup.awayOff.avg));
              // whole-career line, not first-inning specific, so it only nudges lightly
              var fiMatchupSignal = (matchup.homeOff ? matchup.homeOff.avg - LEAGUE_AVG_BA : 0) +
                (matchup.awayOff ? matchup.awayOff.avg - LEAGUE_AVG_BA : 0);
              var fiMatchupAdj = clampNum(fiMatchupSignal * -0.4, -0.03, 0.03);
              reasons2.push("先發對戰數據:" + fiMatchupParts.join(";") +
                (fiMatchupAdj ? "(NRFI " + (fiMatchupAdj >= 0 ? "+" : "") + (fiMatchupAdj * 100).toFixed(1) + "%,非首局專屬數據,僅輕度調整)" : "") + "。");
              nrfi += fiMatchupAdj;
            }
            nrfi = clampNum(nrfi, 0.05, 0.95);
            var nrOdds = nrfiOddsMap[away.name + "|" + home.name] || null;
            var pickNrfi, prob2, beNr, priceLabel;
            if (nrOdds) {
              // real prices: pick whichever side has the higher model probability
              var beN = impliedProb(nrOdds.under), beY = impliedProb(nrOdds.over);
              pickNrfi = nrfi >= 0.5;
              prob2 = pickNrfi ? nrfi : 1 - nrfi;
              beNr = pickNrfi ? beN : beY;
              priceLabel = (pickNrfi ? nrOdds.under : nrOdds.over) + "(" + nrOdds.book + ")";
              reasons2.push("實際賠率(" + esc(nrOdds.book) + "):NRFI(Under 0.5)" + esc(nrOdds.under) +
                " / YRFI(Over 0.5)" + esc(nrOdds.over) + ",取模型機率較高的一邊。");
            } else {
              // no market found: assume the common -110 line
              pickNrfi = nrfi >= 0.5;
              prob2 = pickNrfi ? nrfi : 1 - nrfi;
              beNr = impliedProb(NRFI_PRICE);
              priceLabel = NRFI_PRICE + "(參考)";
            }
            reasons2.push("估計 " + (pickNrfi ? "NRFI" : "YRFI") + " 機率 <b>" + pctStr(prob2) +
              "</b>,以 " + esc(priceLabel) + " 計損益兩平為 " + pctStr(beNr) +
              ",優勢 <b>" + ((prob2 - beNr) >= 0 ? "+" : "") + ((prob2 - beNr) * 100).toFixed(1) + "%</b>。");
            var extra = extras[gi] || {
              weather: null,
              box: { awayTop3: [], homeTop3: [], umpire: null },
              ops7: { away: null, home: null },
              hitters: {},
            };
            var cl = buildChecklist({
              ppA: ppA, ppH: ppH,
              aP1: ppA ? fiByPitcher[ppA.id] : null,
              hP1: ppH ? fiByPitcher[ppH.id] : null,
              aHand: aSt._hand || null, hHand: hSt._hand || null,
              aFi: aFi, hFi: hFi,
              venue: g.venue && g.venue.name,
              weather: extra.weather, box: extra.box,
              ops7: extra.ops7, hitters: extra.hitters,
              nrOdds: nrOdds,
            });
            var veto = pickNrfi && cl.gate.length >= 2;
            if (veto) reasons2.push("⚠ 檢查表「直接 PASS」條件命中 " + cl.gate.length + " 項,依規則不下 NRFI,已自排行剔除。");
            else if (!pickNrfi && cl.gate.length) reasons2.push("檢查表 PASS 條件命中 " + cl.gate.length + " 項(對 NRFI 不利),與 YRFI 方向一致。");
            candidates.push(Object.assign({}, base, {
              type: pickNrfi ? "nrfi" : "yrfi",
              pick: pickNrfi ? "NRFI 首局雙方皆不得分" : "YRFI 首局至少一方得分",
              price: priceLabel,
              prob: prob2,
              market: beNr,
              edge: prob2 - beNr,
              reasons: reasons2,
              checklist: cl,
              veto: veto,
            }));
          }

          // -- 大小分 (game total O/U) --
          var tot = totMap[away.name + "|" + home.name];
          var totVenue = g.venue && g.venue.name;
          var totWx = extras[gi] && extras[gi].weather;
          var parkRunAdj = parkTotalRunAdj(totVenue);
          var weatherRunAdj = weatherTotalRunAdj(totWx);
          var expTot = expectedTotalRuns(aFi, hFi, aSt.era, hSt.era, dynLeagueEra, parkRunAdj, weatherRunAdj,
            matchup.awayOff, matchup.homeOff, aBullEra, hBullEra, dynLeagueBullEra);
          if (tot && expTot !== null) {
            var pOver = overProbOf(expTot, tot.line);
            var beO = impliedProb(tot.over), beU = impliedProb(tot.under);
            if (beO !== null && beU !== null) {
              var pickOver = pOver >= 0.5;
              var probT = pickOver ? pOver : 1 - pOver;
              var beT = pickOver ? beO : beU;
              var reasons3 = [
                "客隊近 " + aFi.n + " 場平均得 " + aFi.rsAvg.toFixed(1) + " 分/失 " + aFi.raAvg.toFixed(1) +
                  " 分;主隊近 " + hFi.n + " 場平均得 " + hFi.rsAvg.toFixed(1) + " 分/失 " + hFi.raAvg.toFixed(1) + " 分。",
              ];
              if (ppA && ppH && (aSt.era || hSt.era)) {
                reasons3.push("先發 ERA:" + esc(ppA.fullName) + " " + esc(aSt.era || "-") +
                  " vs " + esc(ppH.fullName) + " " + esc(hSt.era || "-") +
                  ",對照聯盟平均 " + dynLeagueEra.toFixed(2) + " 已計入總分調整。");
              }
              if (ppA && ppH && (matchup.awayOff || matchup.homeOff)) {
                var totMatchupParts = [];
                if (matchup.homeOff) totMatchupParts.push("主隊打線對 " + esc(ppA.fullName) + " 生涯合計打擊率 " +
                  ops3(matchup.homeOff.avg) + "(" + matchup.homeOff.atBats + " 打數)");
                if (matchup.awayOff) totMatchupParts.push("客隊打線對 " + esc(ppH.fullName) + " 生涯合計打擊率 " +
                  ops3(matchup.awayOff.avg) + "(" + matchup.awayOff.atBats + " 打數)");
                reasons3.push("先發對戰數據(該先發對戰該隊生涯 + 該隊打者對戰該先發生涯,合併計入總分調整):" +
                  totMatchupParts.join(";") + "。");
              }
              if (isFinite(aBullEra) && isFinite(hBullEra)) {
                reasons3.push("牛棚 ERA:客 " + aBullEra.toFixed(2) + " vs 主 " + hBullEra.toFixed(2) +
                  ",對照聯盟牛棚平均 " + dynLeagueBullEra.toFixed(2) + " 已計入總分調整。");
              }
              if (parkRunAdj) {
                reasons3.push("球場「" + esc(totVenue) + "」" + (parkRunAdj > 0 ? "偏打者向,總分預期 +" : "偏投手向,總分預期 ") +
                  parkRunAdj.toFixed(1) + " 分。");
              }
              if (weatherRunAdj) {
                reasons3.push("天氣(" + esc((totWx && totWx.temp ? totWx.temp + "°F、" : "") + (totWx && totWx.wind || "")) + ")" +
                  (weatherRunAdj > 0 ? "有利進攻,總分預期 +" : "抑制進攻,總分預期 ") + weatherRunAdj.toFixed(1) + " 分。");
              }
              reasons3.push("模型預期總分 <b>" + expTot.toFixed(1) + "</b> 分 vs 盤口總分線 <b>" + tot.line +
                "</b>,估計大分機率 " + pctStr(pOver) + " / 小分 " + pctStr(1 - pOver) + "。");
              reasons3.push("取優勢較高的「" + (pickOver ? "大分" : "小分") + "」:機率 <b>" + pctStr(probT) +
                "</b>,以 " + esc(pickOver ? tot.over : tot.under) + " 計損益兩平 " + pctStr(beT) +
                ",優勢 <b>" + ((probT - beT) >= 0 ? "+" : "") + ((probT - beT) * 100).toFixed(1) + "%</b>。");
              if (!tot.real) reasons3.push("ESPN 僅開出總分線、尚未開出大小分價位,暫以 -110 參考水位估算,開盤後請以實際賠率為準。");
              candidates.push(Object.assign({}, base, {
                type: pickOver ? "over" : "under",
                pick: (pickOver ? "大分 Over " : "小分 Under ") + tot.line,
                price: (pickOver ? tot.over : tot.under) + (tot.real ? "" : "(參考)"),
                prob: probT,
                market: beT,
                edge: probT - beT,
                reasons: reasons3,
              }));
            }
          }
        });
        return candidates;
      });
    });
  }

  // ---------- NBA data (edge = ESPN predictor vs. market) ----------
  // temporarily disabled (NBA off-season) — kept for when it's re-enabled
  /*
  function collectNba() {
    var ymd = usTodayISO().replace(/-/g, "");
    return fetchJson("https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard?dates=" + ymd)
      .then(function (data) {
        var pend = (data.events || []).filter(function (ev) {
          var st = ev.competitions && ev.competitions[0] && ev.competitions[0].status;
          return st && st.type && st.type.state === "pre";
        }).slice(0, 12);
        return Promise.all(pend.map(function (ev) {
          var comp = ev.competitions[0];
          var ml = extractMl(comp.odds);
          if (!ml) return Promise.resolve(null);
          var home = (comp.competitors || []).find(function (c) { return c.homeAway === "home"; });
          var away = (comp.competitors || []).find(function (c) { return c.homeAway === "away"; });
          if (!home || !away) return Promise.resolve(null);
          return fetchJson("https://site.api.espn.com/apis/site/v2/sports/basketball/nba/summary?event=" + ev.id)
            .then(function (s) {
              var pred = s.predictor;
              var aProj = pred && pred.awayTeam && parseFloat(pred.awayTeam.gameProjection);
              var hProj = pred && pred.homeTeam && parseFloat(pred.homeTeam.gameProjection);
              if (!aProj || !hProj || aProj + hProj <= 0) return null;
              var fair = fairProbs(ml.a.cur, ml.h.cur);
              if (!fair) return null;
              var modelH = hProj / (aProj + hProj);
              var edgeH = modelH - fair.home, edgeA = (1 - modelH) - fair.away;
              var pickHome = modelH >= 0.5;
              var edge = pickHome ? edgeH : edgeA;
              var prob = pickHome ? modelH : 1 - modelH;
              var reasons = [
                "ESPN 預測:客 " + aProj.toFixed(1) + "% / 主 " + hProj.toFixed(1) + "%。",
                "模型勝率 <b>" + pctStr(prob) + "</b> vs 市場中性機率 " + pctStr(pickHome ? fair.home : fair.away) +
                  ",優勢 <b>" + (edge >= 0 ? "+" : "") + (edge * 100).toFixed(1) + "%</b>。",
              ];
              var mv = mlMoveNote(ml, pickHome, away.team.displayName, home.team.displayName);
              if (mv) reasons.push(mv);
              return {
                league: "NBA", type: "ml",
                away: away.team.displayName, home: home.team.displayName,
                start: ev.date,
                pick: pickHome ? home.team.displayName + " 主勝" : away.team.displayName + " 客勝",
                price: String(pickHome ? ml.h.cur : ml.a.cur),
                prob: prob, market: pickHome ? fair.home : fair.away, edge: edge,
                reasons: reasons,
              };
            })
            .catch(function () { return null; });
        }));
      })
      .then(function (arr) { return arr.filter(Boolean); })
      .catch(function () { return []; });
  }
  */

  // ---------- WNBA data (edge = own record/scoring model vs. market) ----------
  // ESPN's free WNBA predictor endpoint only exposes a relative-strength
  // "gameProjection" percentage (same as NBA above), not a projected score, so
  // it can't drive 大小分/讓分. Team win-loss + scoring standings are used
  // instead to build an independent win-probability and expected-total model,
  // the same way collectMlb() does from MLB Stats API standings/splits.
  var WNBA_TOTAL_SD = 15; // approx combined-score stdev; also used as the margin-SD proxy in homeCoverProb (see its comment)
  function parseWnbaLastTen(summary) {
    if (!summary) return null;
    var parts = String(summary).split("-");
    var w = Number(parts[0]), l = Number(parts[1]);
    return (w + l) > 0 ? w / (w + l) : null;
  }
  function fetchWnbaStandings() {
    return fetchJson("https://site.api.espn.com/apis/v2/sports/basketball/wnba/standings?level=3")
      .then(function (d) {
        var map = {};
        (d.children || []).forEach(function (grp) {
          ((grp.standings && grp.standings.entries) || []).forEach(function (e) {
            var teamId = e.team && e.team.id;
            if (!teamId) return;
            var stat = { wins: null, losses: null, winPct: null, avgPointsFor: null, avgPointsAgainst: null, lastTen: null };
            (e.stats || []).forEach(function (s) {
              if (s.name === "wins") stat.wins = numOr(s.value);
              else if (s.name === "losses") stat.losses = numOr(s.value);
              else if (s.name === "winPercent") stat.winPct = numOr(s.value);
              else if (s.name === "avgPointsFor") stat.avgPointsFor = numOr(s.value);
              else if (s.name === "avgPointsAgainst") stat.avgPointsAgainst = numOr(s.value);
              else if (s.type === "lasttengames") stat.lastTen = s.summary || s.displayValue || null;
            });
            stat.lastTenPct = parseWnbaLastTen(stat.lastTen);
            map[teamId] = stat;
          });
        });
        return map;
      })
      .catch(function () { return {}; });
  }
  // same blend mlbModelHome() uses (record share + last-10 share), plus a
  // scoring-differential nudge in place of starter ERA, plus flat home-court edge
  function wnbaModelHome(aRec, hRec) {
    if (!aRec || !hRec || aRec.winPct === null || hRec.winPct === null) return null;
    var comps = [];
    if (aRec.winPct + hRec.winPct > 0) comps.push(hRec.winPct / (aRec.winPct + hRec.winPct));
    if (aRec.lastTenPct !== null && hRec.lastTenPct !== null && aRec.lastTenPct + hRec.lastTenPct > 0) {
      comps.push(hRec.lastTenPct / (aRec.lastTenPct + hRec.lastTenPct));
    }
    if (!comps.length) return null;
    var m = comps.reduce(function (x, y) { return x + y; }, 0) / comps.length;
    if (aRec.avgPointsFor !== null && hRec.avgPointsFor !== null && aRec.avgPointsAgainst !== null && hRec.avgPointsAgainst !== null) {
      var aDiff = aRec.avgPointsFor - aRec.avgPointsAgainst, hDiff = hRec.avgPointsFor - hRec.avgPointsAgainst;
      m += clampNum((hDiff - aDiff) * 0.008, -0.1, 0.1);
    }
    m += 0.04; // home-court edge
    return clampNum(m, 0.05, 0.95);
  }
  function expectedWnbaTotal(aRec, hRec) {
    if (!aRec || !hRec || aRec.avgPointsFor === null || hRec.avgPointsFor === null) return null;
    return clampNum((aRec.avgPointsFor + hRec.avgPointsAgainst) / 2 + (hRec.avgPointsFor + aRec.avgPointsAgainst) / 2, 120, 220);
  }

  function collectWnba() {
    var ymd = usTodayISO().replace(/-/g, "");
    return Promise.all([
      fetchJson("https://site.api.espn.com/apis/site/v2/sports/basketball/wnba/scoreboard?dates=" + ymd),
      fetchWnbaStandings(),
    ]).then(function (res) {
      var data = res[0], standings = res[1];
      var totMap = buildEspnTotMap(data), spreadMap = buildEspnSpreadMap(data);
      var pend = (data.events || []).filter(function (ev) {
        var st = ev.competitions && ev.competitions[0] && ev.competitions[0].status;
        return st && st.type && st.type.state === "pre";
      });
      var candidates = [];
      pend.forEach(function (ev) {
        var comp = ev.competitions[0];
        var home = (comp.competitors || []).find(function (c) { return c.homeAway === "home"; });
        var away = (comp.competitors || []).find(function (c) { return c.homeAway === "away"; });
        if (!home || !away) return;
        var aRec = standings[away.team.id], hRec = standings[home.team.id];
        var modelH = wnbaModelHome(aRec, hRec);
        var base = { league: "WNBA", away: away.team.displayName, home: home.team.displayName, start: ev.date };
        var key = away.team.displayName + "|" + home.team.displayName;

        // -- 大小分 --
        var tot = totMap[key];
        var expTot = expectedWnbaTotal(aRec, hRec);
        if (tot && expTot !== null) {
          var pOver = 1 - normCdf((tot.line - expTot) / WNBA_TOTAL_SD);
          var beO = impliedProb(tot.over), beU = impliedProb(tot.under);
          if (beO !== null && beU !== null) {
            var pickOver = pOver >= 0.5;
            var probT = pickOver ? pOver : 1 - pOver;
            var beT = pickOver ? beO : beU;
            var reasons3 = [
              "客隊場均得 " + aRec.avgPointsFor.toFixed(1) + " 分/失 " + aRec.avgPointsAgainst.toFixed(1) +
                " 分;主隊場均得 " + hRec.avgPointsFor.toFixed(1) + " 分/失 " + hRec.avgPointsAgainst.toFixed(1) + " 分。",
              "模型預期總分 <b>" + expTot.toFixed(1) + "</b> 分 vs 盤口總分線 <b>" + tot.line +
                "</b>,估計大分機率 " + pctStr(pOver) + " / 小分 " + pctStr(1 - pOver) + "。",
              "取優勢較高的「" + (pickOver ? "大分" : "小分") + "」:機率 <b>" + pctStr(probT) +
                "</b>,以 " + esc(pickOver ? tot.over : tot.under) + " 計損益兩平 " + pctStr(beT) +
                ",優勢 <b>" + ((probT - beT) >= 0 ? "+" : "") + ((probT - beT) * 100).toFixed(1) + "%</b>。",
            ];
            if (!tot.real) reasons3.push("ESPN 僅開出總分線、尚未開出大小分價位,暫以 -110 參考水位估算,開盤後請以實際賠率為準。");
            candidates.push(Object.assign({}, base, {
              type: pickOver ? "over" : "under",
              pick: (pickOver ? "大分 Over " : "小分 Under ") + tot.line,
              price: (pickOver ? tot.over : tot.under) + (tot.real ? "" : "(參考)"),
              prob: probT, market: beT, edge: probT - beT,
              reasons: reasons3,
            }));
          }
        }

        // -- 讓分 --
        var sp = spreadMap[key];
        if (sp && modelH !== null) {
          var pHomeCover = homeCoverProb(modelH, sp.home.line, WNBA_TOTAL_SD);
          var beHomeSp = impliedProb(sp.home.price), beAwaySp = impliedProb(sp.away.price);
          if (beHomeSp !== null && beAwaySp !== null) {
            var pickHomeSp = pHomeCover >= 0.5;
            var probSp = pickHomeSp ? pHomeCover : 1 - pHomeCover;
            var beSp = pickHomeSp ? beHomeSp : beAwaySp;
            var lineSp = pickHomeSp ? sp.home.line : sp.away.line;
            var priceSp = pickHomeSp ? sp.home.price : sp.away.price;
            var reasonsSp = [
              "戰績:客 " + aRec.wins + "-" + aRec.losses + " vs 主 " + hRec.wins + "-" + hRec.losses +
                ";場均得失分差:客 " + (aRec.avgPointsFor - aRec.avgPointsAgainst).toFixed(1) +
                " vs 主 " + (hRec.avgPointsFor - hRec.avgPointsAgainst).toFixed(1) + "。",
              "模型獨贏勝率 <b>" + pctStr(modelH) + "</b>(主)反推期望分差,估計" +
                (pickHomeSp ? "主" : "客") + "隊讓分 " + (lineSp >= 0 ? "+" : "") + lineSp +
                " 覆蓋機率 <b>" + pctStr(probSp) + "</b>。",
              "以 " + esc(priceSp) + " 計損益兩平 " + pctStr(beSp) + ",優勢 <b>" +
                ((probSp - beSp) >= 0 ? "+" : "") + ((probSp - beSp) * 100).toFixed(1) + "%</b>。",
            ];
            candidates.push(Object.assign({}, base, {
              type: "spread",
              pick: (pickHomeSp ? home.team.displayName : away.team.displayName) + " " + (lineSp >= 0 ? "+" : "") + lineSp,
              price: String(priceSp),
              prob: probSp, market: beSp, edge: probSp - beSp,
              reasons: reasonsSp,
            }));
          }
        }
      });
      return candidates;
    }).catch(function () { return []; });
  }

  // ---------- KBO / NPB: own-stats model (with market-consensus fallback) ----------
  // Neither ESPN nor MLB Stats API covers Korean/Japanese baseball, but two
  // unofficial-ish scrapeable sources fill the gap: atplayertw.com.tw runs a
  // clean NPB standings table, and for
  // KBO — which that site doesn't carry — the official English-language
  // eng.koreabaseball.com turns out to be plain server-rendered ASPX tables,
  // easy to scrape despite being "official". Both feed a real record/scoring
  // model (statsModelHome/statsExpectedTotal) that's then
  // compared against The Odds API's real market — the same model-vs-market
  // shape as collectMlb()/collectWnba(), instead of only market-vs-market.
  // When a game's teams can't be matched to stats (site down, name format
  // changed, etc.) each market quietly falls back to the original line-
  // shopping edge (consensus vig-free probability across every book vs. the
  // single best price anywhere) so a scrape failure degrades gracefully
  // instead of dropping the game.
  function americanToDecimal(price) {
    var o = Number(String(price || "").replace(/^\+/, ""));
    if (!isFinite(o) || o === 0) return null;
    return o > 0 ? 1 + o / 100 : 1 + 100 / (-o);
  }
  function bestAmerican(list) {
    var best = null, bestDec = -Infinity;
    (list || []).forEach(function (x) {
      var d = americanToDecimal(x.price);
      if (d !== null && d > bestDec) { bestDec = d; best = x; }
    });
    return best;
  }
  function fairPair(priceA, priceB) {
    var a = impliedProb(priceA), b = impliedProb(priceB);
    if (a === null || b === null || a + b === 0) return null;
    return { a: a / (a + b), b: b / (a + b) };
  }
  function avgArr(arr) { return arr.reduce(function (x, y) { return x + y; }, 0) / arr.length; }
  function mostCommonKey(map) {
    var bestK = null, bestN = 0;
    Object.keys(map).forEach(function (k) { if (map[k].length > bestN) { bestN = map[k].length; bestK = k; } });
    return bestK;
  }

  function fetchOddsApiFull(sportKey, cacheKey) {
    if (!getOddsApiKeys().length) return Promise.resolve([]);
    var cache = null;
    try { cache = JSON.parse(localStorage.getItem(cacheKey)); } catch (e) {}
    if (cache && cache.t && Date.now() - cache.t < 3 * 3600 * 1000 && cache.data) {
      return Promise.resolve(cache.data);
    }
    return fetchOddsApiWithFallback(function (key) {
      return "https://api.the-odds-api.com/v4/sports/" + sportKey +
        "/odds?apiKey=" + encodeURIComponent(key) + "&regions=us&markets=h2h,spreads,totals&oddsFormat=american";
    })
      .then(function (data) {
        try { localStorage.setItem(cacheKey, JSON.stringify({ t: Date.now(), data: data })); } catch (e) {}
        return data;
      })
      .catch(function () { return []; });
  }

  // record+scoring model shared by KBO/NPB's own-stats path (same shape
  // as wnbaModelHome/expectedWnbaTotal: win% comparison + small home nudge,
  // runs-scored/allowed averages folded into an expected total)
  function statsModelHome(aStat, hStat) {
    if (!aStat || !hStat || aStat.winPct + hStat.winPct === 0) return null;
    return clampNum(hStat.winPct / (aStat.winPct + hStat.winPct) + 0.03, 0.05, 0.95);
  }
  function statsExpectedTotal(aStat, hStat, lo, hi) {
    if (!aStat || !hStat || aStat.rsAvg == null || hStat.rsAvg == null || aStat.raAvg == null || hStat.raAvg == null) return null;
    return clampNum((aStat.rsAvg + hStat.raAvg) / 2 + (hStat.rsAvg + aStat.raAvg) / 2, lo, hi);
  }

  // atplayertw.com.tw/npb/'s "戰績排名" section has two standings tables
  // (Central + Pacific League) — scan every <table
  // class="atp-table"> inside the section rather than just the first so both
  // leagues are captured.
  function parseAtpStandings(html) {
    var start = html.indexOf("戰績排名");
    var section = start === -1 ? html : html.slice(start);
    var nextH2 = section.indexOf('<h2 class="atp-section__title">', 10);
    if (nextH2 !== -1) section = section.slice(0, nextH2);
    var tables = section.match(/<table class="atp-table">[\s\S]*?<\/table>/g) || [];
    var map = {};
    tables.forEach(function (tbl) {
      (tbl.match(/<tr>[\s\S]*?<\/tr>/g) || []).forEach(function (row) {
        var nameM = row.match(/atp-standings__team-text">([^<]+)</);
        if (!nameM) return; // header row has no team-text
        var cells = row.match(/<td class="is-center">([^<]*)<\/td>/g) || [];
        var vals = cells.map(function (c) { return c.replace(/<[^>]+>/g, "").trim(); });
        if (vals.length < 7) return; // W, L, PCT, GB, 得, 失, 分差
        var w = Number(vals[0]), l = Number(vals[1]), rs = Number(vals[4]), ra = Number(vals[5]);
        if (!isFinite(w) || !isFinite(l) || w + l <= 0) return;
        map[nameM[1].trim()] = {
          name: nameM[1].trim(),
          wins: w, losses: l, winPct: w / (w + l),
          rsAvg: isFinite(rs) ? rs / (w + l) : null,
          raAvg: isFinite(ra) ? ra / (w + l) : null,
        };
      });
    });
    return map;
  }

  // ---------- NPB stats source: atplayertw.com.tw ----------
  // Odds API team names are English/romanized; atplayertw's are Chinese, so
  // matching goes through a keyword table instead of exact string equality.
  var NPB_TEAM_KEYWORDS = {
    "阪神虎": ["HANSHIN"],
    "讀賣巨人": ["YOMIURI", "GIANTS"],
    "橫濱 DeNA 灣星": ["YOKOHAMA", "DENA", "BAYSTARS"],
    "養樂多燕子": ["YAKULT", "SWALLOWS"],
    "中日龍": ["CHUNICHI", "DRAGONS"],
    "廣島東洋鯉魚": ["HIROSHIMA", "CARP"],
    "福岡軟銀鷹": ["SOFTBANK", "HAWKS"],
    "千葉羅德海洋": ["LOTTE", "MARINES"],
    "埼玉西武獅": ["SEIBU", "LIONS"],
    "東北樂天金鷲": ["RAKUTEN", "EAGLES"],
    "歐力士野牛": ["ORIX", "BUFFALOES"],
    "北海道日本火腿鬥士": ["NIPPON-HAM", "NIPPONHAM", "FIGHTERS"],
  };
  function fetchNpbStats() {
    return fetchViaProxy("https://atplayertw.com.tw/npb/", "atp-standings")
      .then(parseAtpStandings)
      .catch(function () { return {}; });
  }
  function matchNpbTeam(englishName, map) {
    if (!englishName) return null;
    var up = englishName.toUpperCase();
    var found = null;
    Object.keys(NPB_TEAM_KEYWORDS).forEach(function (cn) {
      if (found || !map[cn]) return;
      if (NPB_TEAM_KEYWORDS[cn].some(function (kw) { return up.indexOf(kw) !== -1; })) found = map[cn];
    });
    return found;
  }

  // ---------- NPB today's-starter ERA: baseball-freak.com ----------
  // npb.jp's own official 予告先発 (probable starters) page has no ERA — only
  // names + player-page links, and fetching each pitcher's own page (~12 per
  // day) through the shared CORS proxy was judged too slow/risky for the
  // proxy quota shared with KBO/MLB. baseball-freak.com/starter.html
  // solves that the same way mykbostats.com does for KBO: one page lists
  // every game's probable starters *and* their season ERA together, so it's
  // a single fetch. Team identity comes from the page's own team-icon
  // filename code (image/icon/{code}.png) rather than parsing the Japanese
  // team name text, since the code set is small, fixed, and unambiguous.
  var NPB_FREAK_CODE_TO_KEY = {
    g: "讀賣巨人", t: "阪神虎", s: "養樂多燕子", c: "廣島東洋鯉魚", d: "中日龍", yb: "橫濱 DeNA 灣星",
    l: "埼玉西武獅", bs: "歐力士野牛", f: "北海道日本火腿鬥士", m: "千葉羅德海洋", e: "東北樂天金鷲", h: "福岡軟銀鷹",
  };
  function parseNpbFreakStarters(html) {
    var tblM = html.match(/<table class="yokoku">[\s\S]*?<\/table>/);
    if (!tblM) return {};
    var map = {};
    var cellRe = /<td width="42%"[^>]*>[\s\S]*?<\/td>/g;
    var m;
    while ((m = cellRe.exec(tblM[0]))) {
      var codeM = m[0].match(/icon\/([a-z]+)\.png/);
      var eraM = m[0].match(/防御率([\d.]+)/); // first match = season ERA line (comes before the "対X" matchup-specific line)
      if (!codeM || !eraM) continue;
      var key = NPB_FREAK_CODE_TO_KEY[codeM[1]];
      var era = Number(eraM[1]);
      if (key && isFinite(era) && era > 0) map[key] = era;
    }
    return map;
  }
  function fetchNpbTodayStarterEra() {
    return fetchViaProxy("https://baseball-freak.com/starter.html", "yokoku")
      .then(parseNpbFreakStarters)
      .catch(function () { return {}; });
  }

  // ---------- KBO stats source: eng.koreabaseball.com (official, but plain
  // server-rendered ASPX tables — no free JSON API exists for KBO either) ----------
  // TeamStandings.aspx has W/L/PCT; stats/TeamStats.aspx has team batting (R
  // = runs scored) and team pitching (ERA, used as a runs-allowed-per-game
  // proxy since a KBO game is also 9 innings — there's no free "runs
  // allowed" column the way NPB's 得/失 gives one directly). Team
  // identity is the short code used site-wide (KT, SAMSUNG, LG, DOOSAN, KIA,
  // HANWHA, NC, LOTTE, SSG, KIWOOM); matching against Odds API names is a
  // plain substring check since the 10 codes don't collide with each other.
  function extractTableBySummary(html, summaryText) {
    var re = new RegExp('<table\\s+summary="' + summaryText + '"[\\s\\S]*?<\\/table>', "i");
    var m = html.match(re);
    return m ? m[0] : null;
  }
  function tdValues(rowHtml) {
    var re = /<td[^>]*>([^<]*)<\/td>/g, out = [], m;
    while ((m = re.exec(rowHtml))) out.push(m[1].trim());
    return out;
  }
  function tableRows(tableHtml) {
    return (tableHtml.match(/<tr[^>]*>[\s\S]*?<\/tr>/g) || []).filter(function (r) { return r.indexOf("<td") !== -1; });
  }
  function fetchKboStats() {
    return Promise.all([
      fetchViaProxy("https://eng.koreabaseball.com/Standings/TeamStandings.aspx", "team standings"),
      fetchViaProxy("https://eng.koreabaseball.com/stats/TeamStats.aspx", "Team Batting Stats"),
    ]).then(function (res) {
      var map = {};
      var standTbl = extractTableBySummary(res[0], "team standings");
      if (standTbl) tableRows(standTbl).forEach(function (row) {
        var v = tdValues(row); // RK, TEAM, GAMES, W, L, D, PCT, GB, STREAK, HOME, AWAY
        if (v.length < 5) return;
        var code = v[1], w = Number(v[3]), l = Number(v[4]);
        if (!code || !isFinite(w) || !isFinite(l) || w + l <= 0) return;
        map[code] = { code: code, wins: w, losses: l, winPct: w / (w + l), rsAvg: null, raAvg: null };
      });
      var battingTbl = extractTableBySummary(res[1], "Team Batting Stats");
      if (battingTbl) tableRows(battingTbl).forEach(function (row) {
        var v = tdValues(row); // TEAM, AVG, G, PA, AB, R, ...
        if (v.length < 6 || !map[v[0]]) return;
        var g = Number(v[2]), r = Number(v[5]);
        if (isFinite(g) && g > 0 && isFinite(r)) map[v[0]].rsAvg = r / g;
      });
      var pitchingTbl = extractTableBySummary(res[1], "Team Pitching Stats");
      if (pitchingTbl) tableRows(pitchingTbl).forEach(function (row) {
        var v = tdValues(row); // TEAM, ERA, ...
        if (v.length < 2 || !map[v[0]]) return;
        var era = Number(v[1]);
        if (isFinite(era) && era > 0) map[v[0]].raAvg = era; // runs/9 ≈ runs/game proxy
      });
      return map;
    }).catch(function () { return {}; });
  }
  function matchKboTeam(englishName, map) {
    if (!englishName) return null;
    var up = englishName.toUpperCase();
    var found = null;
    Object.keys(map).forEach(function (code) {
      if (!found && up.indexOf(code) !== -1) found = map[code];
    });
    return found;
  }

  // ---------- KBO today's-starter ERA: mykbostats.com ----------
  // Team season ERA (above) blends starters and bullpen together; MLB's model
  // additionally nudges off the specific starter pitching *today* — no KBO
  // source publishes that as a clean team-keyed feed, but mykbostats.com's
  // homepage lists every game's probable starters and links a single
  // "compare" page carrying all of them at once (one page = every team's
  // starter for the day, no per-pitcher fetch needed), with each row already
  // labeled by team, so no separate name-matching pass is needed either.
  function parseMykboCompare(html) {
    var map = {};
    (html.match(/<tr class="current">[\s\S]*?<\/tr>/g) || []).forEach(function (row) {
      var teamM = row.match(/\/teams\/\d+">([^<]+)</);
      var eraM = row.match(/team-cell">[\s\S]*?<\/td>\s*<td>([\d.]+)<\/td>/);
      if (!teamM || !eraM) return;
      var era = Number(eraM[1]);
      if (isFinite(era) && era > 0) map[teamM[1].trim().toUpperCase()] = era;
    });
    return map;
  }
  function fetchKboTodayStarterEra() {
    return fetchViaProxy("https://mykbostats.com/", "ds-game-card")
      .then(function (homeHtml) {
        var m = homeHtml.match(/href="(\/stats\/compare\?pids=[^"]*)"/);
        if (!m) return {};
        var url = "https://mykbostats.com" + m[1].replace(/&amp;/g, "&");
        return fetchViaProxy(url, "ERA").then(parseMykboCompare).catch(function () { return {}; });
      })
      .catch(function () { return {}; });
  }
  // nudges a team's raAvg toward today's actual starter's ERA instead of the
  // team's season-long blended figure, capped so one outlier start can't
  // swing the total too far
  function applyStarterEraNudge(teamStat, starterEra) {
    if (!teamStat || teamStat.raAvg == null || !isFinite(starterEra) || starterEra <= 0) return teamStat;
    var adj = clampNum((starterEra - teamStat.raAvg) * 0.4, -1.2, 1.2);
    return Object.assign({}, teamStat, { raAvg: teamStat.raAvg + adj, starterEra: starterEra });
  }

  // ---------- KBO ballpark run environment (static table) ----------
  // No live per-park run-factor feed exists for KBO the way MLB Stats API's
  // venue data does, so this is a fixed table sourced from 2024 season HR
  // park-factor rankings (a commonly cited proxy for scoring environment
  // when a direct runs-factor isn't available for every park): Daegu
  // (Samsung) and Incheon (SSG) are far above the rest of the league,
  // Jamsil (LG/Doosan, shared) and Gocheok (Kiwoom, dome) and Sajik (Lotte)
  // are the clear pitcher-friendly end, and the remaining four parks sit
  // close enough to neutral that no adjustment is applied — matches the
  // conservative, extremes-only approach MLB's own parkTotalRunAdj() takes
  // (Coors gets a nudge, the rest of the league doesn't). Daejeon (Hanwha)
  // opened a brand-new stadium in 2025 with no established run environment
  // yet, so it's left neutral rather than guessed at.
  var KBO_PARK_ADJ = {
    SAMSUNG: 0.8, // 大邱三星獅子公園,2024 HR park factor 1.522(聯盟最高)
    SSG: 0.7,     // 仁川SSG蘭德斯球場,1.489
    LG: -0.5,     // 蠶室棒球場(LG/Doosan 共用),0.732,大球場出名壓分
    DOOSAN: -0.5, // 蠶室棒球場(同上)
    KIWOOM: -0.4, // 高尺天空巨蛋,室內巨蛋,0.822
    LOTTE: -0.5,  // 釜山沙職球場,0.729(聯盟最低)
  };

  // ---------- NPB ballpark run environment (static table) ----------
  // Same rationale as KBO_PARK_ADJ above, sourced from baseball-datapark.skr.jp's
  // 2024 season HR park-factor table (verified against the live page, not
  // estimated): unlike KBO this covers all 12 parks with real per-park
  // numbers rather than just the extremes, so every team gets a small
  // adjustment scaled off (factor − 1) × 1.5 runs (capped ±1.0) instead of
  // only flagging the outliers — 神宮(Yakult)/エスコンF(Nippon-Ham) sit far
  // above the rest of the league, 甲子園(Hanshin)/バンテリン(Chunichi)/
  // 楽天モバイル(Rakuten) are the clear pitcher-friendly end.
  var NPB_PARK_ADJ = {
    "養樂多燕子": 1.0,       // 神宮,1.645
    "北海道日本火腿鬥士": 0.9, // エスコンフィールド,1.594
    "福岡軟銀鷹": 0.4,       // PayPayドーム,1.253
    "讀賣巨人": 0.4,         // 東京ドーム,1.236
    "千葉羅德海洋": 0.1,     // ZOZOマリン,1.078
    "歐力士野牛": -0.1,      // 京セラドーム大阪,0.917
    "橫濱 DeNA 灣星": -0.2,  // 横浜スタジアム,0.877
    "廣島東洋鯉魚": -0.3,    // MAZDA Zoom-Zoom スタジアム,0.805
    "埼玉西武獅": -0.4,      // ベルーナドーム,0.764
    "中日龍": -0.5,          // バンテリンドーム,0.693
    "東北樂天金鷲": -0.5,    // 楽天モバイルパーク宮城,0.677
    "阪神虎": -0.5,          // 甲子園,0.682
  };

  // ---------- KBO/NPB weather: Open-Meteo (public, CORS-enabled, no key or
  // proxy needed — unlike every other KBO/NPB source above) ----------
  // Only heat is modeled, the same threshold MLB's own weatherTotalRunAdj()
  // uses (≥95°F). MLB's wind-direction nudge isn't reproduced here: it needs
  // each park's home-plate-to-center-field bearing to tell "blowing out"
  // from "blowing in", and no free source for that was found for KBO/NPB
  // parks — guessing a direction would be worse than leaving it out.
  var KBO_PARK_COORDS = {
    SAMSUNG: [35.841, 128.682], SSG: [37.436, 126.694], NC: [35.223, 128.583],
    KT: [37.300, 127.010], HANWHA: [36.318, 127.430], KIA: [35.168, 126.889],
    KIWOOM: [37.498, 126.867], LG: [37.512, 127.072], DOOSAN: [37.512, 127.072],
    LOTTE: [35.194, 129.062],
  };
  var NPB_PARK_COORDS = {
    "讀賣巨人": [35.706, 139.752], "養樂多燕子": [35.675, 139.716], "橫濱 DeNA 灣星": [35.444, 139.638],
    "中日龍": [35.145, 136.946], "阪神虎": [34.722, 135.362], "廣島東洋鯉魚": [34.392, 132.486],
    "福岡軟銀鷹": [33.595, 130.362], "歐力士野牛": [34.667, 135.476], "北海道日本火腿鬥士": [42.975, 141.689],
    "東北樂天金鷲": [38.262, 140.891], "埼玉西武獅": [35.760, 139.534], "千葉羅德海洋": [35.605, 140.036],
  };
  function fetchTodayMaxTemp(lat, lon, tz) {
    return fetchJson("https://api.open-meteo.com/v1/forecast?latitude=" + lat + "&longitude=" + lon +
        "&daily=temperature_2m_max&temperature_unit=fahrenheit&timezone=" + encodeURIComponent(tz))
      .then(function (d) {
        var t = d.daily && d.daily.temperature_2m_max && d.daily.temperature_2m_max[0];
        return isFinite(t) ? t : null;
      })
      .catch(function () { return null; });
  }
  function fetchParkWeather(coordsMap, tz) {
    var codes = Object.keys(coordsMap);
    return Promise.all(codes.map(function (code) {
      return fetchTodayMaxTemp(coordsMap[code][0], coordsMap[code][1], tz);
    })).then(function (temps) {
      var map = {};
      codes.forEach(function (code, i) { map[code] = temps[i]; });
      return map;
    });
  }
  function weatherHeatAdj(tempF) {
    if (tempF === null || tempF === undefined || !isFinite(tempF)) return 0;
    if (tempF >= 95) return 0.3;
    if (tempF >= 90) return 0.15;
    return 0;
  }

  function collectOddsApiLeague(sportKey, leagueLabel, cacheKey, statsLookup, sd) {
    sd = sd || TOTAL_SD;
    return fetchOddsApiFull(sportKey, cacheKey).then(function (events) {
      var now = Date.now();
      var candidates = [];
      (events || []).forEach(function (ev) {
        if (!ev.commence_time || new Date(ev.commence_time).getTime() <= now) return;
        var books = ev.bookmakers || [];
        if (books.length < 2) return;
        var base = { league: leagueLabel, away: ev.away_team, home: ev.home_team, start: ev.commence_time };
        var stat = statsLookup ? statsLookup(ev.away_team, ev.home_team) : null;
        var modelH = stat ? statsModelHome(stat.away, stat.home) : null;

        // -- 獨贏 (h2h) --
        var homeFair = [], homePrices = [], awayPrices = [];
        books.forEach(function (bk) {
          var mk = (bk.markets || []).find(function (m) { return m.key === "h2h"; });
          if (!mk) return;
          var ho = mk.outcomes.find(function (o) { return o.name === ev.home_team; });
          var ao = mk.outcomes.find(function (o) { return o.name === ev.away_team; });
          if (!ho || !ao) return;
          var f = fairPair(ao.price, ho.price);
          if (f) homeFair.push(f.b);
          homePrices.push({ price: ho.price, book: bk.title });
          awayPrices.push({ price: ao.price, book: bk.title });
        });
        var homeProb = modelH !== null ? modelH : (homeFair.length >= 2 ? avgArr(homeFair) : null);
        if (homeProb !== null) {
          var bestHome = bestAmerican(homePrices), bestAway = bestAmerican(awayPrices);
          if (bestHome && bestAway) {
            var beHome = impliedProb(bestHome.price), beAway = impliedProb(bestAway.price);
            var pickHome = homeProb >= 0.5;
            var prob = pickHome ? homeProb : 1 - homeProb;
            var mkt = pickHome ? beHome : beAway;
            var best = pickHome ? bestHome : bestAway;
            candidates.push(Object.assign({}, base, {
              type: "ml",
              pick: pickHome ? ev.home_team + " 主勝" : ev.away_team + " 客勝",
              price: String(best.price),
              prob: prob, market: mkt, edge: prob - mkt,
              reasons: modelH !== null ? [
                "戰績:客 " + stat.away.wins + "-" + stat.away.losses + "(勝率 " + pctStr(stat.away.winPct) + ") vs 主 " +
                  stat.home.wins + "-" + stat.home.losses + "(勝率 " + pctStr(stat.home.winPct) + ")。",
                "自建戰績模型勝率 <b>" + pctStr(prob) + "</b> vs 市場最佳賠付 <b>" + esc(String(best.price)) + "</b>(" + esc(best.book) +
                  ") 損益兩平 " + pctStr(mkt) + ",優勢 <b>" + ((prob - mkt) >= 0 ? "+" : "") + ((prob - mkt) * 100).toFixed(1) + "%</b>。",
              ] : [
                "全市場(" + homeFair.length + " 家書商)去水位平均勝率:主 " + pctStr(homeProb) + " / 客 " + pctStr(1 - homeProb) +
                  "(球隊未能比對到戰績資料,退回跨書商比價)。",
                "取模型機率較高的一邊,以場上最佳賠付 <b>" + esc(String(best.price)) + "</b>(" + esc(best.book) + ") 計損益兩平 " +
                  pctStr(mkt) + ",優勢 <b>" + ((prob - mkt) >= 0 ? "+" : "") + ((prob - mkt) * 100).toFixed(1) + "%</b>。",
              ],
            }));
          }
        }

        // -- 大小分 (totals) --
        var totByPoint = {};
        books.forEach(function (bk) {
          var mk = (bk.markets || []).find(function (m) { return m.key === "totals"; });
          if (!mk) return;
          var ov = mk.outcomes.find(function (o) { return o.name === "Over"; });
          var un = mk.outcomes.find(function (o) { return o.name === "Under"; });
          if (!ov || !un || ov.point === undefined) return;
          var pt = String(ov.point);
          (totByPoint[pt] = totByPoint[pt] || []).push({ book: bk.title, over: ov.price, under: un.price });
        });
        var totLine = mostCommonKey(totByPoint);
        if (totLine !== null) {
          var totRows = totByPoint[totLine];
          if (totRows.length >= 2) {
            var totLineNum = Number(totLine);
            var expTot = modelH !== null ? statsExpectedTotal(stat.away, stat.home, 4, 20) : null;
            if (expTot !== null) expTot = clampNum(expTot + (stat.parkAdj || 0) + (stat.weatherAdj || 0), 4, 20);
            var overProbModel = expTot !== null ? 1 - normCdf((totLineNum - expTot) / sd) : null;
            var fairOvers = [];
            if (overProbModel === null) totRows.forEach(function (r) { var f = fairPair(r.under, r.over); if (f) fairOvers.push(f.b); });
            var pOver = overProbModel !== null ? overProbModel : (fairOvers.length >= 2 ? avgArr(fairOvers) : null);
            if (pOver !== null) {
              var bestOver = bestAmerican(totRows.map(function (r) { return { price: r.over, book: r.book }; }));
              var bestUnder = bestAmerican(totRows.map(function (r) { return { price: r.under, book: r.book }; }));
              if (bestOver && bestUnder) {
                var beOver = impliedProb(bestOver.price), beUnder = impliedProb(bestUnder.price);
                var pickOver = pOver >= 0.5;
                var probT = pickOver ? pOver : 1 - pOver;
                var mktT = pickOver ? beOver : beUnder;
                var bestT = pickOver ? bestOver : bestUnder;
                candidates.push(Object.assign({}, base, {
                  type: pickOver ? "over" : "under",
                  pick: (pickOver ? "大分 Over " : "小分 Under ") + totLineNum,
                  price: String(bestT.price),
                  prob: probT, market: mktT, edge: probT - mktT,
                  reasons: overProbModel !== null ? [
                    "客隊場均得 " + stat.away.rsAvg.toFixed(1) + " 分/失 " + stat.away.raAvg.toFixed(1) + " 分;主隊場均得 " +
                      stat.home.rsAvg.toFixed(1) + " 分/失 " + stat.home.raAvg.toFixed(1) + " 分" +
                      (leagueLabel === "KBO" ? "(失分端無公開資料,以投手防禦率概估)" : "") + "。" +
                      (stat.away.starterEra || stat.home.starterEra
                        ? "今日先發防禦率:客 " + (stat.away.starterEra ? stat.away.starterEra.toFixed(2) : "未公布") +
                          " / 主 " + (stat.home.starterEra ? stat.home.starterEra.toFixed(2) : "未公布") + "。"
                        : "") +
                      (stat.parkAdj ? "主場球場修正 " + (stat.parkAdj >= 0 ? "+" : "") + stat.parkAdj + " 分(靜態表估計)。" : "") +
                      (stat.weatherAdj ? "今日主場高溫預報修正 " + (stat.weatherAdj >= 0 ? "+" : "") + stat.weatherAdj + " 分(Open-Meteo)。" : ""),
                    "自建模型預期總分 <b>" + expTot.toFixed(1) + "</b> 分 vs 盤口總分線 <b>" + totLineNum + "</b>,估計大分機率 " +
                      pctStr(pOver) + " / 小分 " + pctStr(1 - pOver) + ",取優勢較高一邊,以場上最佳賠付 <b>" + esc(String(bestT.price)) +
                      "</b>(" + esc(bestT.book) + ") 計損益兩平 " + pctStr(mktT) + ",優勢 <b>" + ((probT - mktT) >= 0 ? "+" : "") +
                      ((probT - mktT) * 100).toFixed(1) + "%</b>。",
                  ] : [
                    "總分線 " + totLineNum + "(" + totRows.length + " 家書商同線)去水位平均:大分 " + pctStr(pOver) +
                      " / 小分 " + pctStr(1 - pOver) + "(球隊未能比對到戰績資料,退回跨書商比價)。",
                    "取模型機率較高的一邊,以場上最佳賠付 <b>" + esc(String(bestT.price)) + "</b>(" + esc(bestT.book) + ") 計損益兩平 " +
                      pctStr(mktT) + ",優勢 <b>" + ((probT - mktT) >= 0 ? "+" : "") + ((probT - mktT) * 100).toFixed(1) + "%</b>。",
                  ],
                }));
              }
            }
          }
        }

        // -- 讓分 (spreads) --
        var spByPoint = {};
        books.forEach(function (bk) {
          var mk = (bk.markets || []).find(function (m) { return m.key === "spreads"; });
          if (!mk) return;
          var ho = mk.outcomes.find(function (o) { return o.name === ev.home_team; });
          var ao = mk.outcomes.find(function (o) { return o.name === ev.away_team; });
          if (!ho || !ao || ho.point === undefined) return;
          var pt = String(ho.point);
          (spByPoint[pt] = spByPoint[pt] || []).push({ book: bk.title, homePrice: ho.price, awayPrice: ao.price, awayPoint: ao.point });
        });
        var spLine = mostCommonKey(spByPoint);
        if (spLine !== null) {
          var spRows = spByPoint[spLine];
          if (spRows.length >= 2) {
            var spLineNum = Number(spLine);
            var awayLineNum = spRows[0].awayPoint !== undefined ? Number(spRows[0].awayPoint) : -spLineNum;
            var pHomeCoverModel = modelH !== null ? homeCoverProb(modelH, spLineNum, sd) : null;
            var fairHomeCover = [];
            if (pHomeCoverModel === null) spRows.forEach(function (r) { var f = fairPair(r.awayPrice, r.homePrice); if (f) fairHomeCover.push(f.b); });
            var pHomeCover = pHomeCoverModel !== null ? pHomeCoverModel : (fairHomeCover.length >= 2 ? avgArr(fairHomeCover) : null);
            if (pHomeCover !== null) {
              var bestHomeSp = bestAmerican(spRows.map(function (r) { return { price: r.homePrice, book: r.book }; }));
              var bestAwaySp = bestAmerican(spRows.map(function (r) { return { price: r.awayPrice, book: r.book }; }));
              if (bestHomeSp && bestAwaySp) {
                var beHomeSp = impliedProb(bestHomeSp.price), beAwaySp = impliedProb(bestAwaySp.price);
                var pickHomeSp = pHomeCover >= 0.5;
                var probSp = pickHomeSp ? pHomeCover : 1 - pHomeCover;
                var mktSp = pickHomeSp ? beHomeSp : beAwaySp;
                var bestSp = pickHomeSp ? bestHomeSp : bestAwaySp;
                candidates.push(Object.assign({}, base, {
                  type: "spread",
                  pick: pickHomeSp
                    ? ev.home_team + " " + (spLineNum >= 0 ? "+" : "") + spLineNum
                    : ev.away_team + " " + (awayLineNum >= 0 ? "+" : "") + awayLineNum,
                  price: String(bestSp.price),
                  prob: probSp, market: mktSp, edge: probSp - mktSp,
                  reasons: pHomeCoverModel !== null ? [
                    "自建戰績模型獨贏勝率 <b>" + pctStr(modelH) + "</b>(主)反推期望分差,估計讓分線 主" +
                      (spLineNum >= 0 ? "+" : "") + spLineNum + " 覆蓋機率 <b>" + pctStr(probSp) + "</b>,以場上最佳賠付 <b>" +
                      esc(String(bestSp.price)) + "</b>(" + esc(bestSp.book) + ") 計損益兩平 " + pctStr(mktSp) + ",優勢 <b>" +
                      ((probSp - mktSp) >= 0 ? "+" : "") + ((probSp - mktSp) * 100).toFixed(1) + "%</b>。",
                  ] : [
                    "讓分線 主" + (spLineNum >= 0 ? "+" : "") + spLineNum + "(" + spRows.length + " 家書商同線)去水位平均覆蓋率:主 " +
                      pctStr(pHomeCover) + " / 客 " + pctStr(1 - pHomeCover) + "(球隊未能比對到戰績資料,退回跨書商比價)。",
                    "取模型機率較高的一邊,以場上最佳賠付 <b>" + esc(String(bestSp.price)) + "</b>(" + esc(bestSp.book) + ") 計損益兩平 " +
                      pctStr(mktSp) + ",優勢 <b>" + ((probSp - mktSp) >= 0 ? "+" : "") + ((probSp - mktSp) * 100).toFixed(1) + "%</b>。",
                  ],
                }));
              }
            }
          }
        }
      });
      return candidates;
    }).catch(function () { return []; });
  }
  function collectKbo() {
    return Promise.all([
      fetchKboStats(), fetchKboTodayStarterEra(), fetchParkWeather(KBO_PARK_COORDS, "Asia/Seoul"),
    ]).then(function (res) {
      var stats = res[0], starterEra = res[1], weather = res[2];
      return collectOddsApiLeague("baseball_kbo", "KBO", "kboOddsCache", function (awayName, homeName) {
        var a = matchKboTeam(awayName, stats), h = matchKboTeam(homeName, stats);
        if (!a || !h) return null;
        return {
          away: applyStarterEraNudge(a, starterEra[a.code]),
          home: applyStarterEraNudge(h, starterEra[h.code]),
          // KBO teams always host at their own park (no neutral-site games)
          parkAdj: KBO_PARK_ADJ[h.code] || 0,
          weatherAdj: weatherHeatAdj(weather[h.code]),
        };
      }, 4.4);
    });
  }
  function collectNpb() {
    return Promise.all([
      fetchNpbStats(), fetchNpbTodayStarterEra(), fetchParkWeather(NPB_PARK_COORDS, "Asia/Tokyo"),
    ]).then(function (res) {
      var stats = res[0], starterEra = res[1], weather = res[2];
      return collectOddsApiLeague("baseball_npb", "NPB", "npbOddsCache", function (awayName, homeName) {
        var a = matchNpbTeam(awayName, stats), h = matchNpbTeam(homeName, stats);
        if (!a || !h) return null;
        return {
          away: applyStarterEraNudge(a, starterEra[a.name]),
          home: applyStarterEraNudge(h, starterEra[h.name]),
          parkAdj: NPB_PARK_ADJ[h.name] || 0,
          weatherAdj: weatherHeatAdj(weather[h.name]),
        };
      }, 3.9);
    });
  }

  // ---------- render ----------
  var TYPE_LABEL = { ml: "獨贏", nrfi: "首局 NRFI", yrfi: "首局 YRFI", over: "大分", under: "小分", spread: "讓分" };

  function pickCardHtml(c, rank) {
    var kelly = c.noMarket ? null : halfKellyStr(c.prob, String(c.price).replace(/\(.*$/, ""));
    var weakTag = !c.noMarket && c.edge < 0.01 ? '<span class="pick-weak">優勢有限</span>' : "";
    var noMarketTag = c.noMarket ? '<span class="pick-weak">無公開賠率,模型預測</span>' : "";
    return (
      '<div class="pick-card">' +
        '<div class="pick-rank">' + rank + '</div>' +
        '<div class="pick-main">' +
          '<div class="pick-top">' +
            '<span class="pick-type ' + c.type + '">' + TYPE_LABEL[c.type] + '</span>' +
            '<span class="pick-league">' + c.league + '</span>' +
            '<span class="pick-time">台灣時間 ' + esc(formatTime(c.start)) + ' 開賽</span>' +
            weakTag + noMarketTag +
          '</div>' +
          '<div class="pick-match">' + esc(c.away) + ' @ ' + esc(c.home) + '</div>' +
          '<div class="pick-bet">🎯 <b>' + esc(c.pick) + '</b><span class="pick-price">' + (c.noMarket ? "模型推算" : esc(c.price)) + '</span></div>' +
          '<div class="pick-nums">' +
            '<span>模型機率 <b>' + pctStr(c.prob) + '</b></span>' +
            (c.noMarket
              ? '<span>中性基準 <b>50.0%</b></span>'
              : '<span>市場損益兩平 <b>' + pctStr(c.market) + '</b></span>') +
            '<span class="' + (c.edge >= 0 ? "pos" : "neg") + '">' + (c.noMarket ? "信心度" : "優勢") + ' <b>' +
              (c.edge >= 0 ? "+" : "") + (c.edge * 100).toFixed(1) + '%</b></span>' +
            (kelly ? '<span>半凱利注碼 <b>' + kelly + '</b></span>' : "") +
          '</div>' +
          '<ul class="pick-reasons">' +
            c.reasons.map(function (r) { return "<li>" + r + "</li>"; }).join("") +
          '</ul>' +
          (c.checklist ? checklistHtml(c.checklist) : "") +
        '</div>' +
      '</div>'
    );
  }

  // "12-7 (63%)"; null when the sample's too thin to be meaningful (also
  // covers the file not existing yet, before the first scheduled run)
  function winRateStr(bucket) {
    if (!bucket) return null;
    var w = bucket.w || 0, l = bucket.l || 0;
    if (w + l < 3) return null;
    return w + "-" + l + " (" + Math.round((w / (w + l)) * 100) + "%)";
  }

  function sectionHtml(key, title, list, total) {
    var monthRate = picksStats && picksStats.sections && picksStats.sections[key]
      ? winRateStr(picksStats.sections[key].month) : null;
    var head = '<summary class="picks-section-title">' + title +
      '<span class="picks-section-count">候選 ' + total + ' 注' +
      (monthRate ? " · 近30天 " + monthRate : "") + '</span></summary>';
    var body;
    if (!list.length) {
      body = '<div class="empty-state">此類別今天沒有可分析的未開賽場次。</div>';
    } else {
      body = list.map(function (c, i) { return pickCardHtml(c, i + 1); }).join("");
      if (total < TOP_N) {
        body += '<p class="detail-note">此類別今日可分析的候選僅 ' + total + ' 注,已全部列出。</p>';
      }
    }
    return '<details class="picks-section" open>' + head + '<div class="picks-section-body">' + body + '</div></details>';
  }

  function leagueSectionHtml(icon, title, total, subHtml) {
    var head = '<summary class="picks-league-title">' + icon + " " + title +
      '<span class="picks-league-count">共 ' + total + ' 項候選</span></summary>';
    return '<details class="picks-league-section" open>' + head + '<div class="picks-league-body">' + subHtml + '</div></details>';
  }

  function render(candidates) {
    var el = document.getElementById("picksContent");
    var now = Date.now();
    candidates = candidates.filter(function (c) {
      return c.start && new Date(c.start).getTime() > now;
    });
    var byProb = function (a, b) { return b.prob - a.prob; };
    var byEdge = function (a, b) { return b.edge - a.edge; };
    var fiAll = candidates.filter(function (c) { return c.type === "nrfi" || c.type === "yrfi"; }).sort(byProb);
    var fi = fiAll.filter(function (c) { return !c.veto; });
    var vetoed = fiAll.filter(function (c) { return c.veto; });
    var ml = candidates.filter(function (c) { return c.type === "ml"; }).sort(byProb);
    var ou = candidates.filter(function (c) { return c.type === "over" || c.type === "under"; }).sort(byProb);
    var sp = candidates.filter(function (c) { return c.type === "spread"; }).sort(byProb);
    var ouMlb = ou.filter(function (c) { return c.league === "MLB"; });
    var ouWnba = ou.filter(function (c) { return c.league === "WNBA"; });
    var spMlb = sp.filter(function (c) { return c.league === "MLB"; });
    var spWnba = sp.filter(function (c) { return c.league === "WNBA"; });
    var mlMlb = ml.filter(function (c) { return c.league === "MLB"; });
    var mlMlbByEdge = mlMlb.slice().sort(byEdge);
    var mlNba = []; // NBA temporarily disabled — ml.filter(function (c) { return c.league === "NBA"; });
    var ouKbo = ou.filter(function (c) { return c.league === "KBO"; });
    var spKbo = sp.filter(function (c) { return c.league === "KBO"; });
    var mlKbo = ml.filter(function (c) { return c.league === "KBO"; });
    var ouNpb = ou.filter(function (c) { return c.league === "NPB"; });
    var spNpb = sp.filter(function (c) { return c.league === "NPB"; });
    var mlNpb = ml.filter(function (c) { return c.league === "NPB"; });

    if (!fiAll.length && !ml.length && !ou.length && !sp.length) {
      el.innerHTML = '<div class="empty-state">今天沒有可分析的未開賽場次(賽事已全部開打、休兵日,或賠率尚未開出)。<br>盤口通常於美東早上陸續開出,可稍後再回來看。</div>';
      window.__picksSections = {
        mlb_fi: [], mlb_ou: [], mlb_sp: [], mlb_ml: [], mlb_ml_edge: [],
        wnba_ou: [], wnba_sp: [], nba_ml: [],
        kbo_ml: [], kbo_ou: [], kbo_sp: [], npb_ml: [], npb_ou: [], npb_sp: [],
      };
      window.__picksReady = true;
      return;
    }
    var vetoHtml = vetoed.length
      ? '<details class="veto-block"><summary>🚫 依「直接 PASS」規則(命中 ≥2 項)剔除的 NRFI 場次(' +
        vetoed.length + '),點開查看檢查表</summary>' +
        vetoed.map(function (c) { return pickCardHtml(c, "✗"); }).join("") + '</details>'
      : "";
    var keySet = !!getOddsApiKey();
    var mlbSubHtml =
      sectionHtml("mlb_fi", "⚾ 首局 NRFI / YRFI", fi.slice(0, TOP_N), fi.length) +
      vetoHtml +
      sectionHtml("mlb_ou", "📊 大小分 Over/Under", ouMlb.slice(0, TOP_N), ouMlb.length) +
      sectionHtml("mlb_sp", "🎯 讓分 Run Line", spMlb.slice(0, TOP_N), spMlb.length) +
      sectionHtml("mlb_ml", "🏆 獨贏勝率", mlMlb.slice(0, TOP_N), mlMlb.length) +
      sectionHtml("mlb_ml_edge", "🏆 獨贏優勢", mlMlbByEdge.slice(0, TOP_N), mlMlbByEdge.length);
    var wnbaSubHtml =
      sectionHtml("wnba_ou", "📊 大小分 Over/Under", ouWnba.slice(0, TOP_N), ouWnba.length) +
      sectionHtml("wnba_sp", "🎯 讓分 Spread", spWnba.slice(0, TOP_N), spWnba.length);
    // NBA temporarily disabled
    // var nbaSubHtml =
    //   sectionHtml("nba_ml", "🏆 獨贏勝率", mlNba.slice(0, TOP_N), mlNba.length);
    var kboSubHtml =
      sectionHtml("kbo_ml", "🏆 獨贏勝率", mlKbo.slice(0, TOP_N), mlKbo.length) +
      sectionHtml("kbo_ou", "📊 大小分 Over/Under", ouKbo.slice(0, TOP_N), ouKbo.length) +
      sectionHtml("kbo_sp", "🎯 讓分 Run Line", spKbo.slice(0, TOP_N), spKbo.length);
    var npbSubHtml =
      sectionHtml("npb_ml", "🏆 獨贏勝率", mlNpb.slice(0, TOP_N), mlNpb.length) +
      sectionHtml("npb_ou", "📊 大小分 Over/Under", ouNpb.slice(0, TOP_N), ouNpb.length) +
      sectionHtml("npb_sp", "🎯 讓分 Run Line", spNpb.slice(0, TOP_N), spNpb.length);

    // slim, serializable snapshot for scripts/record-picks.js (Playwright)
    // to read via page.evaluate() — same lists/order the page itself shows,
    // just stripped of reasons/checklist/etc. that aren't needed for settlement
    function slim(list) {
      return list.map(function (c) {
        return {
          type: c.type, league: c.league, away: c.away, home: c.home,
          start: c.start, pick: c.pick, prob: c.prob, edge: c.edge, price: c.price,
        };
      });
    }
    window.__picksSections = {
      mlb_fi: slim(fi), mlb_ou: slim(ouMlb), mlb_sp: slim(spMlb),
      mlb_ml: slim(mlMlb), mlb_ml_edge: slim(mlMlbByEdge),
      wnba_ou: slim(ouWnba), wnba_sp: slim(spWnba),
      nba_ml: slim(mlNba),
      kbo_ml: slim(mlKbo), kbo_ou: slim(ouKbo), kbo_sp: slim(spKbo),
      npb_ml: slim(mlNpb), npb_ou: slim(ouNpb), npb_sp: slim(spNpb),
    };
    window.__picksReady = true;
    var mainHtml =
      leagueSectionHtml("⚾", "MLB", fi.length + ouMlb.length + spMlb.length + mlMlb.length, mlbSubHtml) +
      leagueSectionHtml("🏀", "WNBA", ouWnba.length + spWnba.length, wnbaSubHtml) +
      // leagueSectionHtml("🏀", "NBA", mlNba.length, nbaSubHtml) + // NBA temporarily disabled
      leagueSectionHtml("🇰🇷", "KBO 韓國職棒", mlKbo.length + ouKbo.length + spKbo.length, kboSubHtml) +
      leagueSectionHtml("🇯🇵", "NPB 日本職棒", mlNpb.length + ouNpb.length + spNpb.length, npbSubHtml);
    el.innerHTML =
      '<div class="picks-intro analysis-box"><p>' +
      '共掃描 <b>' + candidates.length + '</b> 個候選,先依聯盟(MLB／WNBA／NBA／KBO／NPB)分組,各聯盟下再分「首局 NRFI/YRFI」「大小分」「讓分」「獨贏勝率」等類別,' +
      '各依「模型機率」(勝率)由高至低取前 ' + TOP_N + ' 名;MLB 另外多一個「獨贏優勢」子區塊,同樣是獨贏候選,改依「模型機率 − 市場損益兩平機率」的優勢由高至低取前 ' + TOP_N + ' 名。' +
      '每張 NRFI/YRFI 卡附 15 項進階檢查表;「直接 PASS」條件命中 2 項以上的 NRFI 一律剔除。' +
      '讓分機率由獨贏模型的期望勝率反推期望分差(常態分布近似)計算,並非逐項獨立建模。' +
      'KBO(官方英文站)/NPB(第三方站)改抓球隊戰績與得失分,自建模型對比 The Odds API 市場最佳賠付,優勢意義同 MLB/WNBA;若賽事球隊比對不到戰績資料,才退回跨書商「去水位共識機率 vs. 場上最佳賠付」的比價模型。KBO/NPB 大小分皆會抓當日先發投手防禦率微調失分預期(同 MLB 的先發 ERA 邏輯)、主場球場修正(靜態表,依 2024 全壘打 park factor 估計)、以及當日主場高溫預報修正(Open-Meteo,僅溫度,無球場座向資料故不做風向修正)。' +
      '優勢代表理論期望值,不代表必中;半凱利為對應的建議資金比例上限。</p>' +
      '<p><a href="#" id="oddsKeyLink">' +
      (keySet ? "🔑 The Odds API 金鑰已啟用(NRFI/YRFI、KBO、NPB 賠率;點此更換金鑰)"
              : "🔑 設定免費 The Odds API 金鑰,即可用真實 NRFI/YRFI、KBO、NPB 賠率取代估算") +
      '</a></p></div>' +
      mainHtml;
    var lk = document.getElementById("oddsKeyLink");
    if (lk) lk.addEventListener("click", function (e) {
      e.preventDefault();
      var k = window.prompt("輸入 The Odds API 金鑰(至 the-odds-api.com 免費註冊;留空清除):", getOddsApiKey());
      if (k === null) return;
      try {
        if (k.trim()) localStorage.setItem("oddsApiKey", k.trim());
        else localStorage.removeItem("oddsApiKey");
        localStorage.removeItem("nrfiOddsCache");
        localStorage.removeItem("kboOddsCache");
        localStorage.removeItem("npbOddsCache");
      } catch (err) {}
      run();
    });
  }

  function run() {
    var el = document.getElementById("picksContent");
    el.innerHTML = '<div class="detail-loading"><div class="spinner"></div>正在抓取賽程、賠率與數據,計算今日勝率最高的五注…</div>';
    document.getElementById("updatedAt").textContent = "計算中…";
    Promise.all([
      collectMlb().catch(function () { return []; }),
      Promise.resolve([]), // NBA temporarily disabled — see collectNba() above
      collectWnba().catch(function () { return []; }),
      collectKbo().catch(function () { return []; }),
      collectNpb().catch(function () { return []; }),
      fetchJson("data/picks-stats.json?t=" + Date.now()).catch(function () { return null; }),
    ]).then(function (res) {
      picksStats = res[5];
      render(res[0].concat(res[1]).concat(res[2]).concat(res[3]).concat(res[4]));
      document.getElementById("updatedAt").textContent =
        "計算於 " + new Date().toLocaleTimeString("zh-TW", { hour12: false });
    }).catch(function (err) {
      el.innerHTML = '<div class="error-state">計算失敗:' + esc(err.message || err) + '</div>';
      document.getElementById("updatedAt").textContent = "失敗";
    });
  }

  document.addEventListener("DOMContentLoaded", function () {
    document.getElementById("refreshBtn").addEventListener("click", run);
    run();
  });
})();
