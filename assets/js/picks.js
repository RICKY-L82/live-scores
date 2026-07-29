(function () {
  "use strict";

  // Ranks today's best bets across MLB (moneyline + NRFI/YRFI) and NBA
  // (moneyline vs. ESPN predictor). Every candidate is scored by "edge":
  // model probability minus the market's break-even probability, so the
  // different bet types can be sorted on one scale.
  var NRFI_PRICE = "-110"; // no NRFI market in the free feed; assume the common price
  var TOP_N = 5;

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
  var DEFAULT_ODDS_API_KEY = "3fc688e03b27b3d41eb04f761c7f58c3"; // site owner's free-tier key
  function getOddsApiKey() {
    try { return localStorage.getItem("oddsApiKey") || DEFAULT_ODDS_API_KEY; } catch (e) { return DEFAULT_ODDS_API_KEY; }
  }

  function fetchNrfiOddsMap(games) {
    var key = getOddsApiKey();
    if (!key) return Promise.resolve({});
    var cache = null;
    try { cache = JSON.parse(localStorage.getItem("nrfiOddsCache")); } catch (e) {}
    if (cache && cache.t && Date.now() - cache.t < 3 * 3600 * 1000 && cache.map) {
      return Promise.resolve(cache.map);
    }
    var want = {};
    games.forEach(function (g) { want[g.teams.away.team.name + "|" + g.teams.home.team.name] = true; });
    return fetchJson("https://api.the-odds-api.com/v4/sports/baseball_mlb/events?apiKey=" + encodeURIComponent(key))
      .then(function (events) {
        var targets = (events || []).filter(function (ev) {
          return want[ev.away_team + "|" + ev.home_team];
        }).slice(0, 20);
        return Promise.all(targets.map(function (ev) {
          return fetchJson("https://api.the-odds-api.com/v4/sports/baseball_mlb/events/" + ev.id +
              "/odds?apiKey=" + encodeURIComponent(key) +
              "&regions=us&markets=totals_1st_1_innings&oddsFormat=american")
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
            map[tr.team.id] = {
              wins: tr.wins, losses: tr.losses,
              pct: Number(tr.winningPercentage || (tr.wins + tr.losses > 0 ? tr.wins / (tr.wins + tr.losses) : 0)),
              lastTen: lt ? lt.wins + "-" + lt.losses : null,
              streak: tr.streak ? tr.streak.streakCode : null,
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
  // starter-ERA nudge, flat home advantage
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
    m += 0.035;
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
              // market available: pick the side with the bigger model-vs-market edge
              var edgeH = modelH - fair.home, edgeA = (1 - modelH) - fair.away;
              pickHome = edgeH >= edgeA;
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
                var edgeHomeSp = pHomeCover - beHomeSp, edgeAwaySp = (1 - pHomeCover) - beAwaySp;
                var pickHomeSp = edgeHomeSp >= edgeAwaySp;
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
              // real prices: pick whichever side has the bigger edge
              var beN = impliedProb(nrOdds.under), beY = impliedProb(nrOdds.over);
              pickNrfi = (nrfi - beN) >= ((1 - nrfi) - beY);
              prob2 = pickNrfi ? nrfi : 1 - nrfi;
              beNr = pickNrfi ? beN : beY;
              priceLabel = (pickNrfi ? nrOdds.under : nrOdds.over) + "(" + nrOdds.book + ")";
              reasons2.push("實際賠率(" + esc(nrOdds.book) + "):NRFI(Under 0.5)" + esc(nrOdds.under) +
                " / YRFI(Over 0.5)" + esc(nrOdds.over) + ",取優勢較高的一邊。");
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
              var edgeO = pOver - beO, edgeU = (1 - pOver) - beU;
              var pickOver = edgeO >= edgeU;
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
              var pickHome = edgeH >= edgeA;
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
            var edgeO = pOver - beO, edgeU = (1 - pOver) - beU;
            var pickOver = edgeO >= edgeU;
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
            var edgeHomeSp = pHomeCover - beHomeSp, edgeAwaySp = (1 - pHomeCover) - beAwaySp;
            var pickHomeSp = edgeHomeSp >= edgeAwaySp;
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

  // ---------- render ----------
  var TYPE_LABEL = { ml: "獨贏", nrfi: "首局 NRFI", yrfi: "首局 YRFI", over: "大分", under: "小分", spread: "讓分" };

  function pickCardHtml(c, rank) {
    var kelly = halfKellyStr(c.prob, String(c.price).replace(/\(.*$/, ""));
    var weakTag = c.edge < 0.01 ? '<span class="pick-weak">優勢有限</span>' : "";
    return (
      '<div class="pick-card">' +
        '<div class="pick-rank">' + rank + '</div>' +
        '<div class="pick-main">' +
          '<div class="pick-top">' +
            '<span class="pick-type ' + c.type + '">' + TYPE_LABEL[c.type] + '</span>' +
            '<span class="pick-league">' + c.league + '</span>' +
            '<span class="pick-time">台灣時間 ' + esc(formatTime(c.start)) + ' 開賽</span>' +
            weakTag +
          '</div>' +
          '<div class="pick-match">' + esc(c.away) + ' @ ' + esc(c.home) + '</div>' +
          '<div class="pick-bet">🎯 <b>' + esc(c.pick) + '</b><span class="pick-price">' + esc(c.price) + '</span></div>' +
          '<div class="pick-nums">' +
            '<span>模型機率 <b>' + pctStr(c.prob) + '</b></span>' +
            '<span>市場損益兩平 <b>' + pctStr(c.market) + '</b></span>' +
            '<span class="' + (c.edge >= 0 ? "pos" : "neg") + '">優勢 <b>' + (c.edge >= 0 ? "+" : "") + (c.edge * 100).toFixed(1) + '%</b></span>' +
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

  function sectionHtml(title, list, total) {
    var html = '<h2 class="picks-section-title">' + title +
      '<span class="picks-section-count">候選 ' + total + ' 注</span></h2>';
    if (!list.length) {
      return html + '<div class="empty-state">此類別今天沒有可分析的未開賽場次。</div>';
    }
    html += list.map(function (c, i) { return pickCardHtml(c, i + 1); }).join("");
    if (total < TOP_N) {
      html += '<p class="detail-note">此類別今日可分析的候選僅 ' + total + ' 注,已全部列出。</p>';
    }
    return html;
  }

  function render(candidates) {
    var el = document.getElementById("picksContent");
    var now = Date.now();
    candidates = candidates.filter(function (c) {
      return c.start && new Date(c.start).getTime() > now;
    });
    var byEdge = function (a, b) { return b.edge - a.edge; };
    var fiAll = candidates.filter(function (c) { return c.type === "nrfi" || c.type === "yrfi"; }).sort(byEdge);
    var fi = fiAll.filter(function (c) { return !c.veto; });
    var vetoed = fiAll.filter(function (c) { return c.veto; });
    var ml = candidates.filter(function (c) { return c.type === "ml"; }).sort(byEdge);
    var ou = candidates.filter(function (c) { return c.type === "over" || c.type === "under"; }).sort(byEdge);
    var sp = candidates.filter(function (c) { return c.type === "spread"; }).sort(byEdge);

    if (!fiAll.length && !ml.length && !ou.length && !sp.length) {
      el.innerHTML = '<div class="empty-state">今天沒有可分析的未開賽場次(賽事已全部開打、休兵日,或賠率尚未開出)。<br>盤口通常於美東早上陸續開出,可稍後再回來看。</div>';
      return;
    }
    var vetoHtml = vetoed.length
      ? '<details class="veto-block"><summary>🚫 依「直接 PASS」規則(命中 ≥2 項)剔除的 NRFI 場次(' +
        vetoed.length + '),點開查看檢查表</summary>' +
        vetoed.map(function (c) { return pickCardHtml(c, "✗"); }).join("") + '</details>'
      : "";
    var keySet = !!getOddsApiKey();
    var mainHtml =
      sectionHtml("⚾ 首局 NRFI / YRFI", fi.slice(0, TOP_N), fi.length) +
      vetoHtml +
      sectionHtml("📊 大小分(MLB 全場總分 / WNBA 大小分 Over/Under)", ou.slice(0, TOP_N), ou.length) +
      sectionHtml("🎯 讓分(MLB Run Line / WNBA Spread)", sp.slice(0, TOP_N), sp.length) +
      sectionHtml("🏆 獨贏勝率(MLB / NBA)", ml.slice(0, TOP_N), ml.length);
    el.innerHTML =
      '<div class="picks-intro analysis-box"><p>' +
      '共掃描 <b>' + candidates.length + '</b> 個候選,分為「首局 NRFI/YRFI」「大小分」「讓分」與「獨贏勝率」四區,' +
      '各依「模型機率 − 市場損益兩平機率」的優勢由高至低取前 ' + TOP_N + ' 名。' +
      '每張 NRFI/YRFI 卡附 15 項進階檢查表;「直接 PASS」條件命中 2 項以上的 NRFI 一律剔除。' +
      '讓分機率由獨贏模型的期望勝率反推期望分差(常態分布近似)計算,並非逐項獨立建模。' +
      '優勢代表理論期望值,不代表必中;半凱利為對應的建議資金比例上限。</p>' +
      '<p><a href="#" id="oddsKeyLink">' +
      (keySet ? "🔑 NRFI/YRFI 實際賠率已啟用(The Odds API;點此更換金鑰)"
              : "🔑 設定免費 The Odds API 金鑰,即可用真實 NRFI/YRFI 賠率取代 -110 估算") +
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
      } catch (err) {}
      run();
    });
  }

  function run() {
    var el = document.getElementById("picksContent");
    el.innerHTML = '<div class="detail-loading"><div class="spinner"></div>正在抓取賽程、賠率與數據,計算今日最值得買的五注…</div>';
    document.getElementById("updatedAt").textContent = "計算中…";
    Promise.all([
      collectMlb().catch(function () { return []; }),
      collectNba(),
      collectWnba(),
    ]).then(function (res) {
      render(res[0].concat(res[1]).concat(res[2]));
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
