(function () {
  "use strict";

  var LEAGUES = {
    mlb: { label: "MLB 美國職棒", color: "#d64545" },
    nba: { label: "NBA 美國職籃", color: "#e0762c" },
    wnba: { label: "WNBA 美國女籃", color: "#b0568f" },
  };
  var LEAGUE_ORDER = ["mlb", "nba", "wnba"];

  var state = {
    date: new Date(),
    filter: "all",
    notify: false,
    gamesByLeague: { mlb: [], nba: [], wnba: [] },
    errorByLeague: { mlb: null, nba: null, wnba: null },
    loading: true,
    changedIds: [],
    lastUpdatedStr: null,
  };

  var modal = { game: null };
  var sectionCache = {};
  var mlbFormCache = { t: 0, map: null };

  // ---------- storage (safe against disabled/absent localStorage) ----------
  var store = {
    get: function (k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set: function (k, v) { try { localStorage.setItem(k, v); } catch (e) {} },
    remove: function (k) { try { localStorage.removeItem(k); } catch (e) {} },
    keys: function () { try { return Object.keys(localStorage); } catch (e) { return []; } },
  };

  // ---------- helpers ----------
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
  function isSameDay(a, b) { return toISODate(a) === toISODate(b); }
  function formatDateLabel(d) {
    var today = new Date();
    var yest = new Date(today); yest.setDate(today.getDate() - 1);
    var tom = new Date(today); tom.setDate(today.getDate() + 1);
    if (isSameDay(d, today)) return "今天";
    if (isSameDay(d, yest)) return "昨天";
    if (isSameDay(d, tom)) return "明天";
    return (d.getMonth() + 1) + "/" + d.getDate();
  }
  // MLB/NBA schedules key on the US Eastern date, which lags Taiwan by 12-13h:
  // through a Taiwan morning the active US slate is still "yesterday" locally.
  // Map the selected view date to the same offset from *Eastern* today.
  function usDateStrFor(d) {
    var iso = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" })
      .format(new Date()).split("-");
    var base = new Date(Number(iso[0]), Number(iso[1]) - 1, Number(iso[2]));
    var now = new Date();
    var localToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    var viewDay = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    base.setDate(base.getDate() + Math.round((viewDay - localToday) / 86400000));
    return toISODate(base);
  }
  function formatTime(iso) {
    if (!iso) return "";
    var d = new Date(iso);
    if (isNaN(d.getTime())) return "";
    return d.toLocaleTimeString("zh-TW", { hour: "2-digit", minute: "2-digit", hour12: false });
  }
  function formatDateTime(iso) {
    if (!iso) return "";
    var d = new Date(iso);
    if (isNaN(d.getTime())) return "";
    return (d.getMonth() + 1) + "/" + d.getDate() + " " + formatTime(iso);
  }
  function fetchJson(url) {
    var ctrl = typeof AbortController !== "undefined" ? new AbortController() : null;
    var timer = ctrl ? setTimeout(function () { ctrl.abort(); }, 15000) : null;
    return fetch(url, ctrl ? { signal: ctrl.signal } : undefined)
      .then(function (res) {
        if (!res.ok) throw new Error("API " + res.status);
        return res.json();
      })
      .finally(function () { if (timer) clearTimeout(timer); });
  }

  // ---------- odds ----------
  function extractEspnOdds(oddsArr) {
    if (!oddsArr || !oddsArr.length) return null;
    var o = oddsArr.find(function (x) { return x.moneyline || x.pointSpread || x.total; }) || oddsArr[0];
    function side(m, s) {
      var x = m && m[s];
      if (!x) return null;
      return {
        open: x.open ? (x.open.odds || null) : null,
        cur: x.close ? (x.close.odds || null) : null,
        lineOpen: x.open ? (x.open.line || null) : null,
        line: x.close ? (x.close.line || null) : null,
      };
    }
    var res = {
      provider: o.provider ? (o.provider.displayName || o.provider.name || "") : "",
      overUnder: o.overUnder !== undefined ? o.overUnder : null,
    };
    if (o.moneyline) {
      res.mlAway = side(o.moneyline, "away");
      res.mlHome = side(o.moneyline, "home");
    } else if (o.awayTeamOdds && o.awayTeamOdds.moneyLine !== undefined) {
      res.mlAway = { cur: String(o.awayTeamOdds.moneyLine) };
      res.mlHome = { cur: String(o.homeTeamOdds && o.homeTeamOdds.moneyLine) };
    }
    if (o.pointSpread) {
      res.spAway = side(o.pointSpread, "away");
      res.spHome = side(o.pointSpread, "home");
    }
    if (o.total) {
      res.over = side(o.total, "over");
      res.under = side(o.total, "under");
    }
    if (!res.mlAway && !res.spAway && !res.over && res.overUnder === null) return null;
    return res;
  }

  function stripOU(line) { return String(line || "").replace(/^[ou]/i, ""); }

  // American odds -> implied probability (0..1)
  function impliedProb(american) {
    var o = Number(String(american || "").replace(/^\+/, ""));
    if (isNaN(o) || o === 0) return null;
    return o < 0 ? (-o) / ((-o) + 100) : 100 / (o + 100);
  }
  function pctStr(p) { return (p * 100).toFixed(1) + "%"; }
  function clampNum(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }

  // ---------- game-total (大小分) model — mirrors assets/js/picks.js ----------
  // expected total runs: each side = (own runs scored + opponent runs allowed)/2,
  // nudged by each starter's season ERA vs the ~4.20 league average, plus
  // park/weather run environment (see parkTotalRunAdj/weatherTotalRunAdj below)
  var TOTAL_SD = 4.3; // empirical stdev of MLB combined runs
  var LEAGUE_ERA = 4.2;
  var LEAGUE_AVG_BA = 0.244; // neutral baseline for the pitcher/hitter matchup deviation below
  var MATCHUP_MIN_AB = 15;
  function numOr(v) { var n = Number(v); return isFinite(n) ? n : null; }
  function expectedTotalRuns(aRuns, hRuns, aEra, hEra, leagueEra, parkRunAdj, weatherRunAdj, awayOff, homeOff, aBullEra, hBullEra, leagueBullEra) {
    if (!aRuns || !hRuns || aRuns.rsAvg === null || hRuns.rsAvg === null) return null;
    leagueEra = isFinite(leagueEra) && leagueEra > 0 ? leagueEra : LEAGUE_ERA;
    var tot = (aRuns.rsAvg + hRuns.raAvg) / 2 + (hRuns.rsAvg + aRuns.raAvg) / 2;
    [aEra, hEra].forEach(function (e) {
      e = Number(e);
      if (isFinite(e) && e > 0) tot += clampNum((e - leagueEra) * 0.22, -0.7, 0.7);
    });
    // bullpen ERA gets its own, smaller nudge — a starter typically covers
    // more of a game's innings than the pen does
    leagueBullEra = isFinite(leagueBullEra) && leagueBullEra > 0 ? leagueBullEra : LEAGUE_ERA;
    [aBullEra, hBullEra].forEach(function (e) {
      e = Number(e);
      if (isFinite(e) && e > 0) tot += clampNum((e - leagueBullEra) * 0.15, -0.5, 0.5);
    });
    // each side's offense-vs-today's-opposing-starter matchup average nudges
    // the total the same direction a hot/cold matchup would in practice
    [awayOff, homeOff].forEach(function (m) {
      if (m) tot += clampNum((m.avg - LEAGUE_AVG_BA) * 4, -0.4, 0.4);
    });
    tot += (parkRunAdj || 0) + (weatherRunAdj || 0);
    return clampNum(tot, 5, 13.5);
  }
  // derives today's live starter-ERA baseline from the actual probable-pitcher
  // pool instead of a fixed constant — mirrors picks.js's leagueEraFromPool
  var leagueEraCache = { t: 0, dateStr: null, v: null };
  function getDynLeagueEra() {
    var dateStr = usDateStrFor(state.date);
    if (leagueEraCache.v !== null && leagueEraCache.dateStr === dateStr && Date.now() - leagueEraCache.t < 600000) {
      return Promise.resolve(leagueEraCache.v);
    }
    return fetchJson("https://statsapi.mlb.com/api/v1/schedule?sportId=1&date=" + dateStr + "&hydrate=probablePitcher")
      .then(function (data) {
        var ids = [];
        (data.dates || []).forEach(function (d) {
          (d.games || []).forEach(function (g) {
            var gpp = g.probablePitchers || {};
            if (gpp.away) ids.push(gpp.away.id);
            if (gpp.home) ids.push(gpp.home.id);
          });
        });
        if (!ids.length) return LEAGUE_ERA;
        return fetchJson("https://statsapi.mlb.com/api/v1/people?personIds=" + ids.join(",") +
            "&hydrate=stats(group=[pitching],type=[season])")
          .then(function (d) {
            var vals = [];
            (d.people || []).forEach(function (p) {
              var splits = p.stats && p.stats[0] && p.stats[0].splits;
              var st = splits && splits[0] && splits[0].stat;
              var e = st && Number(st.era);
              if (isFinite(e) && e > 0 && e < 15) vals.push(e);
            });
            return vals.length >= 10 ? vals.reduce(function (a, b) { return a + b; }, 0) / vals.length : LEAGUE_ERA;
          }).catch(function () { return LEAGUE_ERA; });
      })
      .then(function (v) { leagueEraCache = { t: Date.now(), dateStr: dateStr, v: v }; return v; })
      .catch(function () { return LEAGUE_ERA; });
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
  // Inverse normal CDF (Acklam's approximation) + home-cover probability for
  // a run-line market, given only a moneyline-style home win probability —
  // mirrors assets/js/picks.js.
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
  function homeCoverProb(winProb, homeLine, sigma) {
    var mu = sigma * invNormCdf(winProb);
    return 1 - normCdf((-homeLine - mu) / sigma);
  }

  // ---------- park & weather run environment — mirrors assets/js/picks.js ----------
  // these were previously only checked in picks.js's checklist display; this
  // page's game-detail modal never applied them to the NRFI/大小分 numbers at
  // all, even though venue and weather are already fetched for display here.
  var YRFI_PARKS = ["Coors Field", "Great American Ball Park", "Yankee Stadium"];
  var NRFI_PARKS = ["Petco Park", "Oracle Park", "T-Mobile Park"];
  function parseWind(w) {
    if (!w) return null;
    var m = String(w).match(/(\d+(?:\.\d+)?)\s*mph/i);
    return { mph: m ? Number(m[1]) : null, out: /out to/i.test(String(w)), in: /in from/i.test(String(w)) };
  }
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
    var temp = Number(w.temp), wind = parseWind(w.wind), adj = 0;
    if (isFinite(temp) && temp >= 95) adj += 0.3;
    if (wind && wind.mph !== null && wind.mph > 12) {
      if (wind.out) adj += 0.5;
      else if (wind.in) adj -= 0.4;
    }
    return adj;
  }
  function weatherFirstInningAdj(w) {
    if (!w) return 0;
    var temp = Number(w.temp), wind = parseWind(w.wind), adj = 0;
    if (isFinite(temp) && temp >= 95) adj -= 0.02;
    if (wind && wind.mph !== null && wind.mph > 12) {
      if (wind.out) adj -= 0.03;
      else if (wind.in) adj += 0.02;
    }
    return adj;
  }

  // implied-probability table for all posted markets; null if no usable moneyline
  function oddsImpliedAnalysis(od) {
    if (!od || !od.mlAway || !od.mlAway.cur || !od.mlHome || !od.mlHome.cur) return null;
    var ipA = impliedProb(od.mlAway.cur), ipH = impliedProb(od.mlHome.cur);
    if (ipA === null || ipH === null) return null;
    var vig = ipA + ipH;
    var fairA = ipA / vig, fairH = ipH / vig;

    var rows = "";
    rows += '<tr><td>勝負(客)</td><td>' + esc(od.mlAway.cur) + '</td><td>' + pctStr(ipA) + '</td><td>' + pctStr(fairA) + '</td></tr>';
    rows += '<tr><td>勝負(主)</td><td>' + esc(od.mlHome.cur) + '</td><td>' + pctStr(ipH) + '</td><td>' + pctStr(fairH) + '</td></tr>';
    if (od.spAway && od.spAway.cur) {
      var ipSA = impliedProb(od.spAway.cur);
      rows += '<tr><td>讓分(客 ' + esc(od.spAway.line || "") + ')</td><td>' + esc(od.spAway.cur) + '</td><td>' + (ipSA !== null ? pctStr(ipSA) : "-") + '</td><td>-</td></tr>';
    }
    if (od.spHome && od.spHome.cur) {
      var ipSH = impliedProb(od.spHome.cur);
      rows += '<tr><td>讓分(主 ' + esc(od.spHome.line || "") + ')</td><td>' + esc(od.spHome.cur) + '</td><td>' + (ipSH !== null ? pctStr(ipSH) : "-") + '</td><td>-</td></tr>';
    }
    if (od.over && od.over.cur) {
      var ipO = impliedProb(od.over.cur);
      rows += '<tr><td>大分 ' + esc(stripOU(od.over.line)) + '</td><td>' + esc(od.over.cur) + '</td><td>' + (ipO !== null ? pctStr(ipO) : "-") + '</td><td>-</td></tr>';
    }
    if (od.under && od.under.cur) {
      var ipU = impliedProb(od.under.cur);
      rows += '<tr><td>小分 ' + esc(stripOU(od.under.line)) + '</td><td>' + esc(od.under.cur) + '</td><td>' + (ipU !== null ? pctStr(ipU) : "-") + '</td><td>-</td></tr>';
    }
    var tableHtml = '<div class="table-wrap"><table class="stat-table" style="min-width:380px">' +
      '<tr><th>市場</th><th>美式賠率</th><th>隱含機率</th><th>正規化機率</th></tr>' + rows + '</table></div>';
    var vigNote = "<p>隱含機率溢價約 <b>" + ((vig - 1) * 100).toFixed(1) + "%</b>(勝負隱含機率合計 " + pctStr(vig) + ",正規化後即市場中性機率)。</p>";

    return { tableHtml: tableHtml, vigNote: vigNote, fairA: fairA, fairH: fairH };
  }

  function oddsSummary(od) {
    if (!od) return "";
    var p = [];
    if (od.mlAway && od.mlAway.cur) p.push("ML <b>" + esc(od.mlAway.cur) + " / " + esc((od.mlHome && od.mlHome.cur) || "-") + "</b>");
    if (od.spAway && od.spAway.line) p.push("讓分 <b>" + esc(od.spAway.line) + "</b>");
    if (od.over && od.over.line) p.push("大小 <b>" + esc(stripOU(od.over.line)) + "</b>");
    else if (od.overUnder !== null && od.overUnder !== undefined) p.push("大小 <b>" + esc(od.overUnder) + "</b>");
    return p.join(" · ");
  }

  function oddsSummaryPlain(od) {
    return oddsSummary(od).replace(/<\/?b>/g, "");
  }

  function buildEspnOddsMap(data) {
    var map = {};
    (data.events || []).forEach(function (ev) {
      var comp = ev.competitions && ev.competitions[0];
      if (!comp) return;
      var od = extractEspnOdds(comp.odds);
      if (!od) return;
      var home = (comp.competitors || []).find(function (c) { return c.homeAway === "home"; });
      var away = (comp.competitors || []).find(function (c) { return c.homeAway === "away"; });
      if (home && away) map[away.team.displayName + "|" + home.team.displayName] = od;
    });
    return map;
  }

  // odds movement log (observed while this browser has the page open)
  function getOddsLog(gameId) {
    try { return JSON.parse(store.get("om-" + gameId)) || []; } catch (e) { return []; }
  }
  function recordOdds(game) {
    if (!game.odds) return;
    var sig = oddsSummaryPlain(game.odds);
    if (!sig) return;
    var key = "om-" + game.id;
    var arr = getOddsLog(game.id);
    if (arr.length && arr[arr.length - 1].s === sig) return;
    arr.push({ t: Date.now(), s: sig });
    if (arr.length > 40) arr = arr.slice(-40);
    store.set(key, JSON.stringify(arr));
  }
  function cleanupOddsLogs() {
    var cutoff = Date.now() - 3 * 86400000;
    store.keys().forEach(function (k) {
      if (k.indexOf("om-") !== 0) return;
      var arr;
      try { arr = JSON.parse(store.get(k)) || []; } catch (e) { arr = []; }
      if (!arr.length || arr[arr.length - 1].t < cutoff) store.remove(k);
    });
  }

  // ---------- server-side odds history (collected by GitHub Actions cron) ----------
  var oddsHistCache = {}; // league -> { t, data }
  function fetchOddsHistory(league) {
    if (league !== "mlb" && league !== "nba" && league !== "wnba") return Promise.resolve(null);
    var c = oddsHistCache[league];
    if (c && Date.now() - c.t < 240000) return Promise.resolve(c.data);
    return fetchJson("data/odds/" + league + ".json?t=" + Math.floor(Date.now() / 240000))
      .then(function (d) { oddsHistCache[league] = { t: Date.now(), data: d }; return d; })
      .catch(function () { return c ? c.data : null; });
  }
  function findHistEntry(data, espnId, awayName, homeName, startIso) {
    if (!data || !data.events) return null;
    if (espnId && data.events[espnId]) return data.events[espnId];
    var key = awayName + "|" + homeName;
    var hit = null;
    Object.keys(data.events).forEach(function (id) {
      var e = data.events[id];
      if (e.key !== key) return;
      // same matchup repeats across a series; require same local date
      if (startIso && e.date && toISODate(new Date(e.date)) !== toISODate(new Date(startIso))) return;
      hit = e;
    });
    return hit;
  }
  // last snapshot taken before the game started (the "closing line")
  function closingSnap(entry, startIso) {
    var start = new Date(startIso || entry.date).getTime();
    if (isNaN(start)) return null;
    var snaps = entry.snaps || [], close = null;
    for (var i = 0; i < snaps.length; i++) {
      if (snaps[i].t <= start + 10 * 60000) close = snaps[i];
    }
    return close;
  }

  // ---------- pins ----------
  var pinSet = (function () {
    try { return new Set(JSON.parse(store.get("pins")) || []); } catch (e) { return new Set(); }
  })();
  function togglePin(id) {
    if (pinSet.has(id)) pinSet.delete(id); else pinSet.add(id);
    store.set("pins", JSON.stringify(Array.from(pinSet)));
  }

  // ---------- score fetchers ----------
  function fetchMLB(dateStr) {
    var ymd = dateStr.replace(/-/g, "");
    var schedP = fetchJson("https://statsapi.mlb.com/api/v1/schedule?sportId=1&date=" + dateStr + "&hydrate=linescore,team");
    var oddsP = fetchJson("https://site.api.espn.com/apis/site/v2/sports/baseball/mlb/scoreboard?dates=" + ymd)
      .then(buildEspnOddsMap).catch(function () { return {}; });

    return Promise.all([schedP, oddsP]).then(function (results) {
      var data = results[0], oddsMap = results[1];
      var games = [];
      (data.dates || []).forEach(function (d) {
        (d.games || []).forEach(function (g) {
          var status = g.status || {};
          var linescore = g.linescore || {};
          var cat = "scheduled";
          if (status.abstractGameState === "Live") cat = "live";
          else if (status.abstractGameState === "Final") cat = "final";
          else if (/Postponed|Suspended|Cancelled/i.test(status.detailedState || "")) cat = "postponed";

          var detail;
          if (cat === "live") {
            var half = linescore.isTopInning ? "上" : "下";
            detail = (linescore.currentInning ? linescore.currentInning + "局" + half : status.detailedState);
          } else if (cat === "scheduled") {
            detail = formatTime(g.gameDate);
          } else {
            detail = status.detailedState || "";
          }

          var awayName = g.teams.away.team.name;
          var homeName = g.teams.home.team.name;
          games.push({
            id: "mlb-" + g.gamePk,
            league: "mlb",
            gamePk: g.gamePk,
            status: cat,
            detail: detail,
            startTime: g.gameDate,
            odds: oddsMap[awayName + "|" + homeName] || null,
            away: {
              name: awayName,
              score: g.teams.away.score,
              logo: "https://www.mlbstatic.com/team-logos/" + g.teams.away.team.id + ".svg",
            },
            home: {
              name: homeName,
              score: g.teams.home.score,
              logo: "https://www.mlbstatic.com/team-logos/" + g.teams.home.team.id + ".svg",
            },
          });
        });
      });
      return games;
    });
  }

  function fetchEspnBasketball(leagueKey, dateStr) {
    var ymd = dateStr.replace(/-/g, "");
    var url = "https://site.api.espn.com/apis/site/v2/sports/basketball/" + leagueKey + "/scoreboard?dates=" + ymd;
    return fetchJson(url).then(function (data) {
      return (data.events || []).map(function (ev) {
        var comp = ev.competitions[0];
        var home = comp.competitors.find(function (c) { return c.homeAway === "home"; });
        var away = comp.competitors.find(function (c) { return c.homeAway === "away"; });
        var statusType = comp.status.type || {};
        var cat = "scheduled";
        if (statusType.state === "in") cat = "live";
        else if (statusType.state === "post") cat = "final";

        var detail;
        if (cat === "live") {
          detail = (comp.status.period ? "第" + comp.status.period + "節 " : "") + (comp.status.displayClock || "");
        } else if (cat === "scheduled") {
          detail = formatTime(ev.date);
        } else {
          detail = statusType.shortDetail || "已完賽";
        }

        return {
          id: leagueKey + "-" + ev.id,
          league: leagueKey,
          espnId: ev.id,
          status: cat,
          detail: detail,
          startTime: ev.date,
          odds: extractEspnOdds(comp.odds),
          away: { name: away.team.displayName, score: away.score, logo: away.team.logo },
          home: { name: home.team.displayName, score: home.score, logo: home.team.logo },
        };
      });
    });
  }

  var FETCHERS = {
    mlb: fetchMLB,
    nba: function (d) { return fetchEspnBasketball("nba", d); },
    wnba: function (d) { return fetchEspnBasketball("wnba", d); },
  };

  // ---------- notifications ----------
  function canNotify() {
    return typeof Notification !== "undefined" && Notification.permission === "granted";
  }
  function notifyChange(game, isFinal) {
    if (!state.notify || !canNotify()) return;
    try {
      new Notification(LEAGUES[game.league].label + (isFinal ? " 比賽結束" : " 比分變動"), {
        body: game.away.name + " " + scoreText(game.away.score) + " : " +
              scoreText(game.home.score) + " " + game.home.name + "(" + (game.detail || "") + ")",
        tag: game.id,
      });
    } catch (e) {}
  }

  // ---------- load ----------
  function loadLeague(key) {
    var dateStr = usDateStrFor(state.date);
    var prev = {};
    state.gamesByLeague[key].forEach(function (g) { prev[g.id] = g; });

    return FETCHERS[key](dateStr)
      .then(function (games) {
        games.sort(function (a, b) {
          var pa = pinSet.has(a.id) ? 0 : 1, pb = pinSet.has(b.id) ? 0 : 1;
          if (pa !== pb) return pa - pb;
          var order = { live: 0, scheduled: 1, final: 2, postponed: 3 };
          if (order[a.status] !== order[b.status]) return order[a.status] - order[b.status];
          return new Date(a.startTime) - new Date(b.startTime);
        });

        games.forEach(function (g) {
          var old = prev[g.id];
          if (old && (String(old.away.score) !== String(g.away.score) || String(old.home.score) !== String(g.home.score))) {
            state.changedIds.push(g.id);
            notifyChange(g, false);
          } else if (old && old.status === "live" && g.status === "final") {
            state.changedIds.push(g.id);
            notifyChange(g, true);
          }
          recordOdds(g);
        });

        state.gamesByLeague[key] = games;
        state.errorByLeague[key] = null;
      })
      .catch(function (err) {
        state.errorByLeague[key] = err.message || "載入失敗";
      });
  }

  function loadAll() {
    state.loading = true;
    render();
    var keys = state.filter === "all" ? LEAGUE_ORDER : [state.filter];
    return Promise.allSettled(keys.map(loadLeague)).then(function () {
      state.loading = false;
      state.lastUpdatedStr = new Date().toLocaleTimeString("zh-TW", { hour12: false });
      saveSnapshot();
      render();
      updateStatusText();
      hydratePredictions();
    });
  }

  // ---------- snapshot cache (instant paint on reload) ----------
  function saveSnapshot() {
    try {
      store.set("snap", JSON.stringify({
        date: toISODate(state.date),
        data: state.gamesByLeague,
        t: Date.now(),
      }));
    } catch (e) {}
  }
  function restoreSnapshot() {
    try {
      var snap = JSON.parse(store.get("snap"));
      if (snap && snap.date === toISODate(new Date()) && snap.data) {
        state.gamesByLeague = snap.data;
        state.loading = false;
        return true;
      }
    } catch (e) {}
    return false;
  }

  function updateStatusText() {
    var el = document.getElementById("updatedAt");
    if (!el) return;
    el.textContent = state.lastUpdatedStr ? "最後更新 " + state.lastUpdatedStr : "尚未更新";
  }

  // ---------- scoreboard render ----------
  function teamLogoHtml(team) {
    if (team.logo) {
      return '<img class="team-logo" src="' + esc(team.logo) + '" alt="" loading="lazy" onerror="this.replaceWith(Object.assign(document.createElement(\'span\'),{className:\'team-logo-fallback\'}))">';
    }
    return '<span class="team-logo-fallback"></span>';
  }

  function scoreText(score) {
    return score === null || score === undefined ? "-" : String(score);
  }

  function gameCardHtml(game, color) {
    var homeWin = game.status === "final" && game.home.score !== null && game.away.score !== null && Number(game.home.score) > Number(game.away.score);
    var awayWin = game.status === "final" && game.home.score !== null && game.away.score !== null && Number(game.away.score) > Number(game.home.score);

    var statusHtml;
    if (game.status === "live") {
      statusHtml = '<span class="status-pill live"><span class="live-dot"></span>LIVE</span>';
    } else if (game.status === "final") {
      statusHtml = '<span class="status-pill final">已完賽</span>';
    } else if (game.status === "postponed") {
      statusHtml = '<span class="status-pill final">延賽</span>';
    } else {
      statusHtml = '<span class="status-pill scheduled">未開始</span>';
    }

    var pinned = pinSet.has(game.id);
    var pinBtn = '<button class="pin-btn' + (pinned ? " pinned" : "") + '" data-pin="' + esc(game.id) + '" title="釘選置頂">' + (pinned ? "★" : "☆") + '</button>';

    var oddsHtml = "";
    if (game.odds && game.status === "scheduled") {
      var sum = oddsSummary(game.odds);
      var badge = oddsMoveBadge(game.odds);
      if (sum || badge) oddsHtml = '<div class="odds-row">' + sum + badge + '</div>';
    }

    var predictHtml = game.status === "scheduled"
      ? '<div class="predict-block" id="predict-' + esc(game.id) + '"><div class="predict-empty">模型計算中…</div></div>'
      : "";

    return (
      '<div class="game-card clickable" data-gid="' + esc(game.id) + '" style="--league-color:' + color + '">' +
        '<div class="game-status-row"><span class="status-left">' + pinBtn + statusHtml + '</span><span class="game-detail">' + esc(game.detail || "") + '</span></div>' +
        '<div class="team-row' + (awayWin ? " winner" : "") + '">' +
          '<div class="team-info">' + teamLogoHtml(game.away) + '<span class="team-name">' + esc(game.away.name) + '</span></div>' +
          '<span class="team-score">' + esc(scoreText(game.away.score)) + '</span>' +
        '</div>' +
        '<div class="team-row' + (homeWin ? " winner" : "") + '">' +
          '<div class="team-info">' + teamLogoHtml(game.home) + '<span class="team-name">' + esc(game.home.name) + '</span></div>' +
          '<span class="team-score">' + esc(scoreText(game.home.score)) + '</span>' +
        '</div>' +
        oddsHtml +
        predictHtml +
      '</div>'
    );
  }

  function skeletonHtml() {
    var out = "";
    for (var i = 0; i < 3; i++) out += '<div class="skeleton"></div>';
    return out;
  }

  function sectionHtml(key) {
    var league = LEAGUES[key];
    var games = state.gamesByLeague[key];
    var error = state.errorByLeague[key];
    var showLoading = state.loading && games.length === 0 && !error;

    var body;
    if (error) {
      body = '<div class="error-state">' + esc(error) + '<br><button onclick="window.__scoreApp.retryLeague(\'' + key + '\')">重試</button></div>';
    } else if (showLoading) {
      body = '<div class="game-grid">' + skeletonHtml() + '</div>';
    } else if (games.length === 0) {
      body = '<div class="empty-state">這天沒有賽事</div>';
    } else {
      body = '<div class="game-grid">' + games.map(function (g) { return gameCardHtml(g, league.color); }).join("") + '</div>';
    }

    return (
      '<section class="league-section" data-league="' + key + '">' +
        '<div class="league-section-header">' +
          '<span class="league-dot" style="background:' + league.color + '"></span>' +
          '<h2>' + league.label + '</h2>' +
          '<span class="league-count">' + (error ? "" : games.length + " 場") + '</span>' +
        '</div>' +
        body +
      '</section>'
    );
  }

  function render(force) {
    var keys = state.filter === "all" ? LEAGUE_ORDER : [state.filter];
    var container = document.getElementById("content");
    var structureKey = keys.join(",") + "|" + toISODate(state.date);

    if (force || container.dataset.structure !== structureKey) {
      container.dataset.structure = structureKey;
      sectionCache = {};
      var parts = keys.map(function (k) {
        var h = sectionHtml(k);
        sectionCache[k] = h;
        return h;
      });
      container.innerHTML = parts.join("");
    } else {
      keys.forEach(function (k) {
        var h = sectionHtml(k);
        if (sectionCache[k] === h) return;
        sectionCache[k] = h;
        var el = container.querySelector('section[data-league="' + k + '"]');
        if (el) {
          var tmp = document.createElement("div");
          tmp.innerHTML = h;
          el.replaceWith(tmp.firstElementChild);
        }
      });
    }

    // flash score changes
    state.changedIds.forEach(function (id) {
      var card = container.querySelector('[data-gid="' + id + '"]');
      if (card) {
        card.classList.add("flash");
        setTimeout(function () { card.classList.remove("flash"); }, 2600);
      }
    });
    state.changedIds = [];

    document.getElementById("dateLabel").textContent = formatDateLabel(state.date);
  }

  // ================================================================
  // Game detail modal
  // ================================================================

  function findGame(gid) {
    for (var i = 0; i < LEAGUE_ORDER.length; i++) {
      var arr = state.gamesByLeague[LEAGUE_ORDER[i]];
      for (var j = 0; j < arr.length; j++) {
        if (arr[j].id === gid) return arr[j];
      }
    }
    return null;
  }

  function statusPillHtml(game) {
    if (game.status === "live") return '<span class="status-pill live"><span class="live-dot"></span>LIVE</span>';
    if (game.status === "final") return '<span class="status-pill final">已完賽</span>';
    if (game.status === "postponed") return '<span class="status-pill final">延賽</span>';
    return '<span class="status-pill scheduled">未開始</span>';
  }

  function detailHeaderHtml(game, awaySub, homeSub) {
    function teamCol(t, sub) {
      var img = t.logo ? '<img src="' + esc(t.logo) + '" alt="" onerror="this.style.display=\'none\'">' : "";
      return '<div class="detail-team">' + img +
        '<span class="name">' + esc(t.name) + '</span>' +
        (sub ? '<span class="sub">' + esc(sub) + '</span>' : "") +
        '</div>';
    }
    var scoreHtml;
    if (game.status === "scheduled" || game.status === "postponed") {
      scoreHtml = '<div class="detail-score"><span class="sep">vs</span></div>';
    } else {
      scoreHtml = '<div class="detail-score">' + esc(scoreText(game.away.score)) +
        '<span class="sep">:</span>' + esc(scoreText(game.home.score)) + '</div>';
    }
    return (
      '<div class="detail-header">' +
        '<span class="detail-league">' + LEAGUES[game.league].label + '</span>' +
        statusPillHtml(game) +
      '</div>' +
      '<div class="detail-matchup">' +
        teamCol(game.away, awaySub || "客隊") + scoreHtml + teamCol(game.home, homeSub || "主隊") +
      '</div>' +
      '<div class="detail-status-line">' + esc(game.detail || "") + '</div>'
    );
  }

  function sectionBlock(title, inner) {
    return '<div class="detail-section"><h3>' + esc(title) + '</h3>' + inner + '</div>';
  }

  function probBarHtml(awayLabel, homeLabel, awayPct, homePct) {
    return (
      '<div class="prob-bar-wrap">' +
        '<div class="prob-labels"><span>' + esc(awayLabel) + ' <b>' + awayPct.toFixed(1) + '%</b></span>' +
        '<span><b>' + homePct.toFixed(1) + '%</b> ' + esc(homeLabel) + '</span></div>' +
        '<div class="prob-bar"><div class="away-part" style="width:' + awayPct + '%"></div>' +
        '<div class="home-part" style="width:' + homePct + '%"></div></div>' +
      '</div>'
    );
  }

  // ---------- odds detail sections ----------
  function oddsDetailHtml(game) {
    var html = "";
    var od = game.odds;
    if (od) {
      function cell(s) {
        if (!s) return "-";
        var line = s.line ? esc(s.line) + " " : "";
        return line + esc(s.cur || "-");
      }
      function openCell(s) {
        if (!s) return "-";
        var line = s.lineOpen ? esc(s.lineOpen) + " " : "";
        return line + esc(s.open || "-");
      }
      var rows = "";
      if (od.mlAway) {
        rows += '<tr><td>勝負(客)' + '</td><td>' + openCell(od.mlAway) + '</td><td><b>' + cell(od.mlAway) + '</b></td></tr>';
        rows += '<tr><td>勝負(主)' + '</td><td>' + openCell(od.mlHome) + '</td><td><b>' + cell(od.mlHome) + '</b></td></tr>';
      }
      if (od.spAway) {
        rows += '<tr><td>讓分(客)</td><td>' + openCell(od.spAway) + '</td><td><b>' + cell(od.spAway) + '</b></td></tr>';
        rows += '<tr><td>讓分(主)</td><td>' + openCell(od.spHome) + '</td><td><b>' + cell(od.spHome) + '</b></td></tr>';
      }
      if (od.over) {
        rows += '<tr><td>大分</td><td>' + openCell(od.over) + '</td><td><b>' + cell(od.over) + '</b></td></tr>';
        rows += '<tr><td>小分</td><td>' + openCell(od.under) + '</td><td><b>' + cell(od.under) + '</b></td></tr>';
      }
      if (rows) {
        html += sectionBlock("賠率" + (od.provider ? "(" + od.provider + ")" : ""),
          '<div class="table-wrap"><table class="stat-table" style="min-width:320px">' +
          '<tr><th>市場</th><th>開盤</th><th>目前</th></tr>' + rows + '</table></div>' +
          espnMoveNote(od, game) +
          '<div class="detail-note">美式賠率,僅供參考。</div>');
      }
    }

    // filled asynchronously from data/odds/<league>.json (see hydrateOddsHistory)
    html += '<div class="detail-section odds-hist-slot" id="oddsHistSlot" style="display:none"></div>';

    var log = getOddsLog(game.id);
    if (log.length > 1) {
      var items = log.slice(-12).reverse().map(function (e) {
        return '<li><span class="mt">' + formatTime(new Date(e.t).toISOString()) + '</span><span>' + esc(e.s) + '</span></li>';
      }).join("");
      html += sectionBlock("賠率異動紀錄", '<ul class="move-list">' + items + '</ul>' +
        '<div class="detail-note">僅記錄本瀏覽器開啟頁面期間觀測到的變化。</div>');
    }
    return html;
  }

  // ---------- line movement analysis (which side the market is warming to) ----------
  // vig-free home win probability implied by a snapshot's moneyline
  function snapFairHome(s) {
    if (!s || !s.mlA || !s.mlH) return null;
    var a = impliedProb(s.mlA), h = impliedProb(s.mlH);
    if (a === null || h === null || a + h === 0) return null;
    return h / (a + h);
  }

  function moveVerdictHtml(votesHome, votesAway, game) {
    if (votesHome === votesAway) {
      return '<div class="move-verdict flat">⚖️ 市場動向:雙方評價變化不大或方向分歧,暫無明顯傾斜。</div>';
    }
    var homeFav = votesHome > votesAway;
    var name = homeFav ? game.home.name : game.away.name;
    return '<div class="move-verdict ' + (homeFav ? "home" : "away") + '">📈 市場動向:<b>' +
      esc(name) + (homeFav ? "(主)" : "(客)") + '</b> 越來越被看好。</div>';
  }

  function lineMoveAnalysis(entry, game) {
    var snaps = entry.snaps || [];
    if (snaps.length < 2) return "";
    var first = snaps[0], last = snaps[snaps.length - 1];
    var votesHome = 0, votesAway = 0;
    var msgs = [];

    // moneyline: shift in vig-free implied probability
    var f = snapFairHome(first), l = snapFairHome(last);
    if (f !== null && l !== null) {
      var d = (l - f) * 100;
      if (Math.abs(d) >= 1) {
        if (d > 0) votesHome++; else votesAway++;
        var side = d > 0 ? game.home.name + "(主)" : game.away.name + "(客)";
        msgs.push("勝負盤:主隊市場中性機率由 " + pctStr(f) + " 移至 <b>" + pctStr(l) + "</b>(" +
          (d >= 0 ? "+" : "") + d.toFixed(1) + " 百分點),資金流向 <b>" + esc(side) + "</b>。");
      } else {
        msgs.push("勝負盤:隱含機率自開盤僅變動 " + (d >= 0 ? "+" : "") + d.toFixed(1) + " 百分點,市場對勝負的評價大致持平。");
      }
    }

    // spread depth: spA is the away line; more negative = away asked to give more points
    var sf = Number(first.spA), sl = Number(last.spA);
    if (isFinite(sf) && isFinite(sl) && sf !== sl) {
      var towardAway = sl < sf;
      if (towardAway) votesAway++; else votesHome++;
      msgs.push("讓分盤:客隊盤口由 " + esc(String(first.spA)) + " 移至 <b>" + esc(String(last.spA)) + "</b>," +
        (towardAway
          ? "客隊被要求讓出更多分數,市場對<b>" + esc(game.away.name) + "(客)</b>的信心增強"
          : "盤口向主隊方向移動,市場對<b>" + esc(game.home.name) + "(主)</b>的評價上升") + "。");
    }

    // total: market's expectation of combined scoring
    var tf = Number(first.tot), tl = Number(last.tot);
    if (isFinite(tf) && isFinite(tl) && tf !== tl) {
      msgs.push("大小盤:總分線由 " + esc(String(first.tot)) + " 調整至 <b>" + esc(String(last.tot)) + "</b>," +
        (tl > tf ? "市場預期總得分上修,大分方向獲得資金支持" : "市場預期總得分下修,小分方向獲得資金支持") + "。");
    }

    // late window: compare the last ~6h against the overall move to flag steam / reversal
    var cutoff = last.t - 6 * 3600000;
    var recentFirst = null;
    for (var i = 0; i < snaps.length - 1; i++) {
      if (snaps[i].t >= cutoff) { recentFirst = snaps[i]; break; }
    }
    if (recentFirst && f !== null && l !== null) {
      var rf = snapFairHome(recentFirst);
      if (rf !== null) {
        var rd = (l - rf) * 100, od = (l - f) * 100;
        if (Math.abs(rd) >= 1.5) {
          var recentSide = rd > 0 ? game.home.name + "(主)" : game.away.name + "(客)";
          var sameDir = (rd > 0) === (od > 0) && Math.abs(od) >= 1;
          msgs.push("近 6 小時:<b>" + esc(recentSide) + "</b> 隱含機率再升 " + Math.abs(rd).toFixed(1) + " 個百分點," +
            (sameDir ? "與整體走勢同向,盤口持續傾斜,注意臨場 steam move" : "與早盤方向相反,可能有消息面(先發/傷兵)引發市場反轉") + "。");
        }
      }
    }

    if (!msgs.length) return "";
    return moveVerdictHtml(votesHome, votesAway, game) +
      '<div class="analysis-box" style="margin-bottom:10px">' +
      msgs.map(function (m) { return "<p>" + m + "</p>"; }).join("") + '</div>';
  }

  // same idea but from ESPN's own open vs. current prices (works without our sampling)
  function espnMoveNote(od, game) {
    if (!od || !od.mlAway || !od.mlHome) return "";
    var oa = impliedProb(od.mlAway.open), oh = impliedProb(od.mlHome.open);
    var ca = impliedProb(od.mlAway.cur), ch = impliedProb(od.mlHome.cur);
    if (oa === null || oh === null || ca === null || ch === null) return "";
    if (oa + oh === 0 || ca + ch === 0) return "";
    var f0 = oh / (oa + oh), f1 = ch / (ca + ch);
    var d = (f1 - f0) * 100;
    if (Math.abs(d) < 1) return "";
    var side = d > 0 ? game.home.name + "(主)" : game.away.name + "(客)";
    return '<div class="detail-note">開盤至今,<b>' + esc(side) + '</b> 的市場中性勝率由 ' +
      pctStr(f0) + ' 升至 ' + pctStr(f1) + ',為市場資金較看好的一方。</div>';
  }

  // card badge: which side has gained implied probability since open
  function oddsMoveBadge(od) {
    if (!od || !od.mlAway || !od.mlHome) return "";
    var oa = impliedProb(od.mlAway.open), oh = impliedProb(od.mlHome.open);
    var ca = impliedProb(od.mlAway.cur), ch = impliedProb(od.mlHome.cur);
    if (oa === null || oh === null || ca === null || ch === null) return "";
    if (oa + oh === 0 || ca + ch === 0) return "";
    var d = (ch / (ca + ch) - oh / (oa + oh)) * 100;
    if (Math.abs(d) < 1.5) return "";
    return '<span class="move-badge ' + (d > 0 ? "home" : "away") + '" title="開盤至今勝負盤隱含機率變化,箭頭指向市場趨熱的一方">' +
      (d > 0 ? "📈主" : "📈客") + " +" + Math.abs(d).toFixed(1) + '</span>';
  }

  function histTableHtml(entry, startIso) {
    var snaps = entry.snaps || [];
    if (!snaps.length) return "";
    var close = closingSnap(entry, startIso);
    var shown = snaps.slice(-24);
    var rows = "";
    for (var i = shown.length - 1; i >= 0; i--) {
      var s = shown[i], prev = i > 0 ? shown[i - 1] : null;
      var mark = function (field) {
        var v = s[field] === undefined || s[field] === null ? "-" : String(s[field]);
        var changed = prev && String(prev[field] === undefined ? "" : prev[field]) !== String(s[field] === undefined ? "" : s[field]);
        return changed ? "<b>" + esc(v) + "</b>" : esc(v);
      };
      rows += '<tr' + (close && s.t === close.t ? ' class="close-row"' : '') + '>' +
        '<td>' + esc(formatDateTime(new Date(s.t).toISOString())) +
          (close && s.t === close.t ? ' <span class="close-tag">收盤</span>' : '') + '</td>' +
        '<td>' + mark("mlA") + ' / ' + mark("mlH") + '</td>' +
        '<td>' + mark("spA") + ' (' + mark("spAO") + ')</td>' +
        '<td>' + mark("tot") + ' (' + mark("oO") + '/' + mark("uO") + ')</td>' +
        '</tr>';
    }
    return '<div class="table-wrap"><table class="stat-table" style="min-width:460px">' +
      '<tr><th>時間</th><th>勝負(客/主)</th><th>讓分(客)</th><th>大小(O/U)</th></tr>' + rows + '</table></div>' +
      '<div class="detail-note">由本站排程每 20 分鐘採樣 ESPN 盤口,僅在數字變動時記錄。</div>';
  }

  function hydrateOddsHistory(game) {
    if (game.league !== "mlb" && game.league !== "nba" && game.league !== "wnba") return;
    fetchOddsHistory(game.league).then(function (data) {
      if (modal.game !== game) return; // modal switched or closed meanwhile
      var slot = document.getElementById("oddsHistSlot");
      if (!slot) return;
      var entry = data && findHistEntry(data, game.espnId, game.away.name, game.home.name, game.startTime);
      if (!entry || !(entry.snaps || []).length) return;
      slot.style.display = "";
      slot.innerHTML = "<h3>盤口走勢與市場動向</h3>" +
        lineMoveAnalysis(entry, game) +
        histTableHtml(entry, game.startTime);
    });
  }

  // ---------- MLB team form (standings) ----------
  function getMlbForm() {
    if (mlbFormCache.map && Date.now() - mlbFormCache.t < 600000) return Promise.resolve(mlbFormCache.map);
    var season = new Date().getFullYear();
    return fetchJson("https://statsapi.mlb.com/api/v1/standings?leagueId=103,104&season=" + season)
      .then(function (d) {
        var map = {};
        (d.records || []).forEach(function (r) {
          (r.teamRecords || []).forEach(function (tr) {
            var lt = ((tr.records && tr.records.splitRecords) || []).find(function (x) { return x.type === "lastTen"; });
            var ht = ((tr.records && tr.records.splitRecords) || []).find(function (x) { return x.type === "home"; });
            map[tr.team.id] = {
              streak: tr.streak ? tr.streak.streakCode : null,
              lastTen: lt ? lt.wins + "-" + lt.losses : null,
              // home win% — gates the home-advantage nudge in computeMlbPrediction,
              // same rule as picks.js's mlbModelHome
              homeWinPct: ht ? Number(ht.pct || (ht.wins + ht.losses > 0 ? ht.wins / (ht.wins + ht.losses) : 0)) : null,
            };
          });
        });
        mlbFormCache = { t: Date.now(), map: map };
        return map;
      })
      .catch(function () { return {}; });
  }

  // one call covers every team's bullpen ERA for the season — mirrors
  // assets/js/picks.js's fetchBullpenEraMap, feeds the moneyline model
  var bullpenEraCache = { t: 0, map: null };
  function getBullpenEraMap() {
    if (bullpenEraCache.map && Date.now() - bullpenEraCache.t < 600000) return Promise.resolve(bullpenEraCache.map);
    var season = new Date().getFullYear();
    return fetchJson("https://statsapi.mlb.com/api/v1/teams/stats?stats=statSplits&sitCodes=rp&group=pitching&season=" +
        season + "&sportIds=1")
      .then(function (d) {
        var map = {};
        var splits = (d.stats && d.stats[0] && d.stats[0].splits) || [];
        splits.forEach(function (sp) {
          var era = numOr(sp.stat && sp.stat.era);
          if (era !== null && sp.team) map[sp.team.id] = era;
        });
        bullpenEraCache = { t: Date.now(), map: map };
        return map;
      })
      .catch(function () { return {}; });
  }

  // ---------- batter-vs-pitcher matchup signal — mirrors picks.js ----------
  // pitcher's own career line vs the opposing team, blended with that team's
  // currently-posted top-3 hitters' own career line vs this exact starter.
  // Needs a posted lineup (only available ~1-3h before first pitch), so this
  // is often null well ahead of game time — that's fine, it's an optional nudge.
  function fetchBoxTop3(pk) {
    return fetchJson("https://statsapi.mlb.com/api/v1/game/" + pk + "/boxscore")
      .then(function (d) {
        function top3(side) {
          var bo = d.teams && d.teams[side] && d.teams[side].battingOrder;
          return (bo && bo.length >= 3) ? bo.slice(0, 3) : [];
        }
        return { awayTop3: top3("away"), homeTop3: top3("home") };
      })
      .catch(function () { return { awayTop3: [], homeTop3: [] }; });
  }
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

  // ---------- MLB detail ----------
  function renderMlbDetail(game, body) {
    return fetchJson("https://statsapi.mlb.com/api/v1.1/game/" + game.gamePk + "/feed/live").then(function (f) {
      var gd = f.gameData || {};
      var ld = f.liveData || {};
      var html = detailHeaderHtml(
        game,
        recordText(gd.teams && gd.teams.away),
        recordText(gd.teams && gd.teams.home)
      );

      return renderMlbPreview(game, gd, ld, html, body);
    });
  }

  function recordText(t) {
    var r = t && t.record && t.record.leagueRecord;
    if (!r) return "";
    return r.wins + "勝" + r.losses + "敗";
  }


  function mlbLineupSection(title, teamBox) {
    var ids = (teamBox && teamBox.batters) || [];
    if (ids.length < 9) return "";
    var rows = "";
    ids.forEach(function (pid) {
      var p = teamBox.players["ID" + pid];
      if (!p || !p.battingOrder) return;
      var orderNum = Number(p.battingOrder);
      if (orderNum % 100 !== 0) return; // substitutes have non-x00 orders
      var sb = (p.seasonStats && p.seasonStats.batting) || {};
      rows += '<tr><td>' + (orderNum / 100) + '. ' + esc(p.person.fullName) +
        ' <span class="starter-mark">' + esc(p.position ? p.position.abbreviation : "") + '</span></td>' +
        '<td>' + esc(sb.avg || "-") + '</td>' +
        '<td>' + esc(sb.homeRuns !== undefined ? sb.homeRuns : "-") + '</td>' +
        '<td>' + esc(sb.ops || "-") + '</td></tr>';
    });
    if (!rows) return "";
    return '<div><div class="detail-note" style="margin:0 0 4px"><b>' + esc(title) + '</b></div>' +
      '<div class="table-wrap"><table class="stat-table" style="min-width:0">' +
      '<tr><th>先發打線</th><th>打擊率</th><th>全壘打</th><th>OPS</th></tr>' +
      rows + '</table></div></div>';
  }

  // ---------- MLB first-inning (NRFI/YRFI) data ----------
  var fiCache = {};
  function getTeamFirstInningRates(teamId) {
    if (!teamId) return Promise.resolve(null);
    var hit = fiCache[teamId];
    if (hit && Date.now() - hit.t < 600000) return Promise.resolve(hit.v);
    // same sampling window as picks.js: last 25 days, up to 15 games, need >= 8
    var end = new Date(); end.setDate(end.getDate() - 1);
    var start = new Date(); start.setDate(start.getDate() - 25);
    var url = "https://statsapi.mlb.com/api/v1/schedule?sportId=1&teamId=" + teamId +
      "&startDate=" + toISODate(start) + "&endDate=" + toISODate(end) + "&hydrate=linescore";
    return fetchJson(url).then(function (data) {
      var games = [];
      (data.dates || []).forEach(function (d) { games = games.concat(d.games || []); });
      games = games.filter(function (g) {
        return g.status && g.status.abstractGameState === "Final" &&
          g.linescore && g.linescore.innings && g.linescore.innings[0];
      }).slice(-15);
      if (games.length < 8) return null;
      var off = 0, def = 0, rsSum = 0, raSum = 0, runN = 0;
      games.forEach(function (g) {
        var isAway = g.teams.away.team.id === teamId;
        var inn1 = g.linescore.innings[0];
        var own = isAway ? inn1.away : inn1.home;
        var opp = isAway ? inn1.home : inn1.away;
        if (own && Number(own.runs) > 0) off++;
        if (opp && Number(opp.runs) > 0) def++;
        // full-game runs for the game-total (大小分) model
        var rs = Number(isAway ? g.teams.away.score : g.teams.home.score);
        var ra = Number(isAway ? g.teams.home.score : g.teams.away.score);
        if (isFinite(rs) && isFinite(ra)) { rsSum += rs; raSum += ra; runN++; }
      });
      var v = {
        n: games.length, off: off, def: def,
        offRate: off / games.length, defRate: def / games.length,
        rsAvg: runN ? rsSum / runN : null,
        raAvg: runN ? raSum / runN : null,
      };
      fiCache[teamId] = { t: Date.now(), v: v };
      return v;
    }).catch(function () { return null; });
  }

  function getPitcherFirstInningSplit(pid) {
    if (!pid) return Promise.resolve(null);
    var season = new Date().getFullYear();
    return fetchJson("https://statsapi.mlb.com/api/v1/people/" + pid +
        "/stats?stats=statSplits&group=pitching&sitCodes=i01&season=" + season)
      .then(function (d) {
        var sp = d.stats && d.stats[0] && d.stats[0].splits && d.stats[0].splits[0];
        return sp ? sp.stat : null;
      })
      .catch(function () { return null; });
  }

  // ---------- card-level model predictions (獨贏/讓分/大小分) ----------
  // Eagerly computed for every scheduled MLB/NBA/WNBA card so the model's
  // probabilities show up without clicking in — same formulas as the detail
  // modal (renderMlbPreview / nbaPreviewSections), just packaged per-market
  // with a short list of which inputs actually moved the number this game.
  var predictCache = {}; // gameId -> { t, v }
  function computeMlbPrediction(game) {
    var hit = predictCache[game.id];
    if (hit && Date.now() - hit.t < 600000) return Promise.resolve(hit.v);
    return fetchJson("https://statsapi.mlb.com/api/v1.1/game/" + game.gamePk + "/feed/live").then(function (f) {
      var gd = f.gameData || {};
      var pp = gd.probablePitchers || {};
      var awayTeam = gd.teams && gd.teams.away;
      var homeTeam = gd.teams && gd.teams.home;
      var ar = awayTeam && awayTeam.record && awayTeam.record.leagueRecord;
      var hr = homeTeam && homeTeam.record && homeTeam.record.leagueRecord;
      if (!ar || !hr) return null;

      var statFetches = [pp.away, pp.home].map(function (p) {
        return p
          ? fetchJson("https://statsapi.mlb.com/api/v1/people/" + p.id + "?hydrate=stats(group=[pitching],type=[season])").catch(function () { return null; })
          : Promise.resolve(null);
      });

      return Promise.all([
        getMlbForm(),
        Promise.all(statFetches),
        getTeamFirstInningRates(awayTeam.id),
        getTeamFirstInningRates(homeTeam.id),
        getBullpenEraMap(),
        fetchBoxTop3(game.gamePk),
        getDynLeagueEra(),
      ]).then(function (results) {
        var formMap = results[0];
        var statsById = {};
        results[1].forEach(function (r) {
          if (r && r.people && r.people[0]) {
            var person = r.people[0];
            var splits = person.stats && person.stats[0] && person.stats[0].splits;
            statsById[person.id] = (splits && splits[0] && splits[0].stat) || {};
          }
        });
        var awayFi = results[2], homeFi = results[3];
        var bullpenMap = results[4], box = results[5], dynLeagueEra = results[6];
        var aForm = formMap[awayTeam.id], hForm = formMap[homeTeam.id];
        var aSt = pp.away ? (statsById[pp.away.id] || {}) : null;
        var hSt = pp.home ? (statsById[pp.home.id] || {}) : null;

        // batter-vs-pitcher matchup signal — same as picks.js's mlbModelHome
        return Promise.all([
          fetchPitcherVsTeam(pp.away && pp.away.id, homeTeam.id), // away starter's career line vs home team
          fetchPitcherVsTeam(pp.home && pp.home.id, awayTeam.id), // home starter's career line vs away team
          fetchHittersVsPitcher(box.homeTop3, pp.away && pp.away.id), // home hitters vs away starter
          fetchHittersVsPitcher(box.awayTop3, pp.home && pp.home.id), // away hitters vs home starter
        ]).then(function (mres) {
          var homeOff = combineMatchup(mres[0], mres[2]);
          var awayOff = combineMatchup(mres[1], mres[3]);

          var comps = [], mlFactors = [];
          var aP = Number(ar.pct), hP = Number(hr.pct);
          if (aP + hP > 0) { comps.push(hP / (aP + hP)); mlFactors.push("戰績"); }
          function l10rate(fm) {
            if (!fm || !fm.lastTen) return null;
            var parts = fm.lastTen.split("-");
            var w = Number(parts[0]), l = Number(parts[1]);
            return (w + l) > 0 ? w / (w + l) : null;
          }
          var aL10 = l10rate(aForm), hL10 = l10rate(hForm);
          if (aL10 !== null && hL10 !== null && aL10 + hL10 > 0) { comps.push(hL10 / (aL10 + hL10)); mlFactors.push("近十場"); }
          if (!comps.length) return null;
          var modelH = comps.reduce(function (x, y) { return x + y; }, 0) / comps.length;
          var aEraN = aSt && aSt.era ? Number(aSt.era) : NaN;
          var hEraN = hSt && hSt.era ? Number(hSt.era) : NaN;
          if (!isNaN(aEraN) && !isNaN(hEraN)) {
            modelH += clampNum((aEraN - hEraN) * 0.04, -0.06, 0.06);
            mlFactors.push("先發 ERA");
          }
          if (homeOff || awayOff) {
            var homeAvg = homeOff ? homeOff.avg : LEAGUE_AVG_BA;
            var awayAvg = awayOff ? awayOff.avg : LEAGUE_AVG_BA;
            modelH += clampNum((homeAvg - awayAvg) * 0.6, -0.05, 0.05);
            mlFactors.push("打者對戰先發");
          }
          var aBullEra = bullpenMap[awayTeam.id], hBullEra = bullpenMap[homeTeam.id];
          if (isFinite(aBullEra) && isFinite(hBullEra)) {
            modelH += clampNum((aBullEra - hBullEra) * 0.03, -0.045, 0.045);
            mlFactors.push("牛棚 ERA");
          }
          if (hForm && hForm.homeWinPct !== null && hForm.homeWinPct !== undefined && hForm.homeWinPct > 0.6) {
            modelH += 0.035;
            mlFactors.push("主場優勢");
          }
          modelH = clampNum(modelH, 0.05, 0.95);

          var result = { ml: { prob: modelH, factors: mlFactors } };

          var od = game.odds;
          if (od && od.spHome && od.spHome.line !== undefined && od.spHome.line !== null) {
            var spLine = Number(od.spHome.line);
            if (isFinite(spLine)) {
              result.spread = { prob: homeCoverProb(modelH, spLine, TOTAL_SD), line: spLine, factors: mlFactors };
            }
          }

          var totLine = null;
          if (od) {
            if (od.over && od.over.line) {
              var tl = Number(stripOU(od.over.line));
              if (isFinite(tl) && tl > 0) totLine = tl;
            } else if (od.overUnder !== null && od.overUnder !== undefined) {
              var tl2 = Number(od.overUnder);
              if (isFinite(tl2) && tl2 > 0) totLine = tl2;
            }
          }
          var venueName = gd.venue && gd.venue.name;
          var parkRunAdj = parkTotalRunAdj(venueName);
          var weatherRunAdj = weatherTotalRunAdj(gd.weather);
          var aStT = pp.away ? (statsById[pp.away.id] || {}) : {};
          var hStT = pp.home ? (statsById[pp.home.id] || {}) : {};
          var bullVals = Object.keys(bullpenMap).map(function (id) { return bullpenMap[id]; }).filter(function (v) { return isFinite(v) && v > 0; });
          var dynLeagueBullEra = bullVals.length ? bullVals.reduce(function (a, b) { return a + b; }, 0) / bullVals.length : LEAGUE_ERA;
          var expTot = expectedTotalRuns(awayFi, homeFi, aStT.era, hStT.era, dynLeagueEra, parkRunAdj, weatherRunAdj,
            awayOff, homeOff, aBullEra, hBullEra, dynLeagueBullEra);
          if (totLine !== null && expTot !== null) {
            var totFactors = ["兩隊近況得失分"];
            if (aStT.era || hStT.era) totFactors.push("先發 ERA");
            if (isFinite(aBullEra) && isFinite(hBullEra)) totFactors.push("牛棚 ERA");
            if (homeOff || awayOff) totFactors.push("打者對戰先發");
            if (parkRunAdj) totFactors.push("球場");
            if (weatherRunAdj) totFactors.push("天氣");
            result.total = { prob: overProbOf(expTot, totLine), line: totLine, factors: totFactors };
          }

          predictCache[game.id] = { t: Date.now(), v: result };
          return result;
        });
      });
    }).catch(function () { return null; });
  }

  function computeBballPrediction(game) {
    var hit = predictCache[game.id];
    if (hit && Date.now() - hit.t < 600000) return Promise.resolve(hit.v);
    return fetchJson("https://site.api.espn.com/apis/site/v2/sports/basketball/" + game.league + "/summary?event=" + game.espnId).then(function (s) {
      var pred = s.predictor;
      var aProj = pred && pred.awayTeam && parseFloat(pred.awayTeam.gameProjection);
      var hProj = pred && pred.homeTeam && parseFloat(pred.homeTeam.gameProjection);
      if (!aProj || !hProj || aProj + hProj <= 0) return null;
      var result = { ml: { prob: hProj / (aProj + hProj), factors: ["ESPN 勝率預測"] } };
      predictCache[game.id] = { t: Date.now(), v: result };
      return result;
    }).catch(function () { return null; });
  }

  var PREDICT_FETCHERS = { mlb: computeMlbPrediction, nba: computeBballPrediction, wnba: computeBballPrediction };

  function predictBlockHtml(pred) {
    if (!pred || !pred.ml) return '<div class="predict-empty">模型資料不足,暫無預測。</div>';
    var lines = [];
    lines.push('<div class="predict-line"><span>🎯 獨贏</span><span>主 <b>' + pctStr(pred.ml.prob) +
      '</b> · 客 <b>' + pctStr(1 - pred.ml.prob) + '</b></span></div>');
    var factors = pred.ml.factors.slice();
    if (pred.spread) {
      var spLine = pred.spread.line;
      lines.push('<div class="predict-line"><span>📐 讓分 主' + (spLine >= 0 ? "+" : "") + spLine + '</span><span>主 <b>' +
        pctStr(pred.spread.prob) + '</b> · 客 <b>' + pctStr(1 - pred.spread.prob) + '</b></span></div>');
    }
    if (pred.total) {
      lines.push('<div class="predict-line"><span>📊 大小 ' + pred.total.line + '</span><span>大 <b>' +
        pctStr(pred.total.prob) + '</b> · 小 <b>' + pctStr(1 - pred.total.prob) + '</b></span></div>');
      pred.total.factors.forEach(function (f) { if (factors.indexOf(f) === -1) factors.push(f); });
    }
    return lines.join("") + '<div class="predict-note">已依' + factors.join("・") + '調整</div>';
  }

  function hydratePredictions() {
    LEAGUE_ORDER.forEach(function (key) {
      var fn = PREDICT_FETCHERS[key];
      (state.gamesByLeague[key] || []).forEach(function (game) {
        if (game.status !== "scheduled") return;
        fn(game).then(function (pred) {
          var el = document.getElementById("predict-" + game.id);
          if (el) el.innerHTML = predictBlockHtml(pred);
        });
      });
    });
  }

  function renderMlbPreview(game, gd, ld, headerHtml, body) {
    var pp = gd.probablePitchers || {};
    var pitcherIds = [];
    if (pp.away) pitcherIds.push(pp.away.id);
    if (pp.home) pitcherIds.push(pp.home.id);

    var statFetches = pitcherIds.map(function (pid) {
      return fetchJson("https://statsapi.mlb.com/api/v1/people/" + pid + "?hydrate=stats(group=[pitching],type=[season])")
        .catch(function () { return null; });
    });

    var awayTeamId = gd.teams && gd.teams.away && gd.teams.away.id;
    var homeTeamId = gd.teams && gd.teams.home && gd.teams.home.id;

    // posted lineup top-3 (for the batter-vs-pitcher matchup signal) — reuse
    // the boxscore that's already part of this game's live-feed payload
    // instead of a separate fetch; empty before lineups post, same as picks.js
    var lineupBox = ld && ld.boxscore && ld.boxscore.teams;
    function top3(side) {
      var bo = lineupBox && lineupBox[side] && lineupBox[side].battingOrder;
      return (bo && bo.length >= 3) ? bo.slice(0, 3) : [];
    }
    var awayTop3 = top3("away"), homeTop3 = top3("home");

    return Promise.all([
      getMlbForm(),
      Promise.all(statFetches),
      getTeamFirstInningRates(awayTeamId),
      getTeamFirstInningRates(homeTeamId),
      getPitcherFirstInningSplit(pp.away && pp.away.id),
      getPitcherFirstInningSplit(pp.home && pp.home.id),
      getBullpenEraMap(),
      getDynLeagueEra(),
      fetchPitcherVsTeam(pp.away && pp.away.id, homeTeamId), // away starter's career line vs home team
      fetchPitcherVsTeam(pp.home && pp.home.id, awayTeamId), // home starter's career line vs away team
      fetchHittersVsPitcher(homeTop3, pp.away && pp.away.id), // home hitters vs away starter
      fetchHittersVsPitcher(awayTop3, pp.home && pp.home.id), // away hitters vs home starter
    ]).then(function (results) {
      var formMap = results[0];
      var awayFi = results[2], homeFi = results[3];
      var awayP1 = results[4], homeP1 = results[5];
      var bullpenMap = results[6], dynLeagueEra = results[7];
      var homeOff = combineMatchup(results[8], results[10]);
      var awayOff = combineMatchup(results[9], results[11]);
      var statsById = {};
      results[1].forEach(function (r) {
        if (r && r.people && r.people[0]) {
          var person = r.people[0];
          var splits = person.stats && person.stats[0] && person.stats[0].splits;
          statsById[person.id] = (splits && splits[0] && splits[0].stat) || {};
        }
      });

      var html = headerHtml;

      // probable pitchers
      function pitcherCard(teamLabel, p) {
        if (!p) return '<div class="pitcher-card"><div class="p-team">' + esc(teamLabel) + '</div><div class="p-name">先發投手未定</div></div>';
        var st = statsById[p.id] || {};
        return '<div class="pitcher-card">' +
          '<div class="p-team">' + esc(teamLabel) + '</div>' +
          '<div class="p-name">' + esc(p.fullName) + '</div>' +
          '<div class="p-stats">' +
            '<span>戰績 <b>' + esc((st.wins !== undefined ? st.wins : "-") + "-" + (st.losses !== undefined ? st.losses : "-")) + '</b></span>' +
            '<span>ERA <b>' + esc(st.era || "-") + '</b></span>' +
            '<span>三振 <b>' + esc(st.strikeOuts !== undefined ? st.strikeOuts : "-") + '</b></span>' +
            '<span>WHIP <b>' + esc(st.whip || "-") + '</b></span>' +
            '<span>局數 <b>' + esc(st.inningsPitched || "-") + '</b></span>' +
          '</div></div>';
      }
      html += sectionBlock("預定先發投手",
        '<div class="pitcher-compare">' +
        pitcherCard(game.away.name + "(客)", pp.away) +
        pitcherCard(game.home.name + "(主)", pp.home) +
        '</div>');

      // confirmed lineups (posted ~1-3 hours before first pitch)
      var box = ld && ld.boxscore && ld.boxscore.teams;
      var awayLineup = box ? mlbLineupSection(game.away.name, box.away) : "";
      var homeLineup = box ? mlbLineupSection(game.home.name, box.home) : "";
      if (awayLineup || homeLineup) {
        html += sectionBlock("先發打線(已公布)",
          '<div class="lineup-grid">' + awayLineup + homeLineup + '</div>');
      } else {
        html += sectionBlock("先發打線",
          '<div class="analysis-box"><p>先發打線尚未公布,MLB 通常於開賽前 1–3 小時公布,屆時重新開啟本視窗即可看到。</p></div>');
      }

      // meta
      var metaItems = [];
      var dt = gd.datetime && gd.datetime.dateTime;
      if (dt) metaItems.push(["開賽時間", formatDateTime(dt)]);
      if (gd.venue && gd.venue.name) metaItems.push(["球場", gd.venue.name]);
      if (gd.weather && gd.weather.condition) {
        var w = gd.weather.condition;
        if (gd.weather.temp) {
          var c = Math.round((Number(gd.weather.temp) - 32) * 5 / 9);
          w += " " + c + "°C";
        }
        metaItems.push(["天氣", w]);
      }
      if (metaItems.length) {
        html += sectionBlock("比賽資訊",
          '<div class="meta-grid">' + metaItems.map(function (m) {
            return '<div class="meta-item"><div class="k">' + esc(m[0]) + '</div><div class="v">' + esc(m[1]) + '</div></div>';
          }).join("") + '</div>');
      }

      // analysis from records + pitcher stats + recent form
      var awayTeam = gd.teams && gd.teams.away;
      var homeTeam = gd.teams && gd.teams.home;
      var ar = awayTeam && awayTeam.record && awayTeam.record.leagueRecord;
      var hr = homeTeam && homeTeam.record && homeTeam.record.leagueRecord;
      var analysis = [];
      if (ar && hr) {
        var aPct = Number(ar.pct), hPct = Number(hr.pct);
        analysis.push("<b>" + esc(game.away.name) + "</b> 目前 " + ar.wins + " 勝 " + ar.losses + " 敗(勝率 " + ar.pct + "),<b>" +
          esc(game.home.name) + "</b> " + hr.wins + " 勝 " + hr.losses + " 敗(勝率 " + hr.pct + ")。" +
          (Math.abs(aPct - hPct) < 0.03 ? "兩隊戰績接近,實力在伯仲之間。"
            : (aPct > hPct ? "客隊整體戰績較佳。" : "主隊整體戰績較佳,加上主場優勢值得留意。")));

        var aForm = awayTeam && formMap[awayTeam.id];
        var hForm = homeTeam && formMap[homeTeam.id];
        if (aForm && hForm && aForm.lastTen && hForm.lastTen) {
          analysis.push("近況:客隊近十場 <b>" + esc(aForm.lastTen) + "</b>" + (aForm.streak ? "(" + esc(aForm.streak) + ")" : "") +
            ",主隊近十場 <b>" + esc(hForm.lastTen) + "</b>" + (hForm.streak ? "(" + esc(hForm.streak) + ")" : "") + "。");
        }

        var aSt = pp.away ? (statsById[pp.away.id] || {}) : null;
        var hSt = pp.home ? (statsById[pp.home.id] || {}) : null;
        if (aSt && hSt && aSt.era && hSt.era) {
          var aera = Number(aSt.era), hera = Number(hSt.era);
          analysis.push("先發對決:" + esc(pp.away.fullName) + "(ERA " + aSt.era + ")對上 " +
            esc(pp.home.fullName) + "(ERA " + hSt.era + ")," +
            (Math.abs(aera - hera) < 0.5 ? "兩位先發表現相近,勝負可能取決於牛棚與打線發揮。"
              : (aera < hera ? "客隊先發防禦率較佳,壓制力略勝一籌。" : "主隊先發防禦率較佳,壓制力略勝一籌。")));
        }

        var total = aPct + hPct;
        if (total > 0) {
          var awayShare = (aPct / total) * 100;
          html += sectionBlock("戰績勝率比較", probBarHtml(game.away.name, game.home.name, awayShare, 100 - awayShare));
        }
      }
      if (analysis.length) {
        html += sectionBlock("賽前分析",
          '<div class="analysis-box">' + analysis.map(function (p) { return "<p>" + p + "</p>"; }).join("") + '</div>' +
          '<div class="detail-note">分析為根據球隊戰績與投手數據之簡易推估,僅供參考。</div>');
      }

      // first-inning (NRFI/YRFI) analysis
      var nrfiProb = null;
      if (awayFi || homeFi) {
        var inner = "";
        var pA, pH;
        // blend each offense's 1st-inning scoring rate with the opponent's 1st-inning concede rate
        if (awayFi && homeFi) {
          pA = (awayFi.offRate + homeFi.defRate) / 2;
          pH = (homeFi.offRate + awayFi.defRate) / 2;
        } else if (awayFi) { pA = awayFi.offRate; pH = awayFi.defRate; }
        else { pA = homeFi.defRate; pH = homeFi.offRate; }
        var nrfi = (1 - pA) * (1 - pH) * 100;
        // starters with extreme first-inning ERA nudge the estimate — same
        // rule as picks.js (needs >= 8 first innings pitched, else too noisy)
        var p1Adj = {};
        [[pp.away, awayP1], [pp.home, homeP1]].forEach(function (pair) {
          var p = pair[0], st = pair[1];
          if (!p || !st || !st.era) return;
          var era = Number(st.era), ip = Number(st.inningsPitched);
          if (!isFinite(era) || !isFinite(ip) || ip < 8) return;
          if (era <= 2.0) { nrfi += 3; p1Adj[p.id] = "+3%"; }
          else if (era >= 6.0) { nrfi -= 3; p1Adj[p.id] = "−3%"; }
        });
        var venueName = gd.venue && gd.venue.name;
        var parkFiAdjPct = parkFirstInningAdj(venueName) * 100;
        var weatherFiAdjPct = weatherFirstInningAdj(gd.weather) * 100;
        nrfi += parkFiAdjPct + weatherFiAdjPct;
        nrfi = clampNum(nrfi, 5, 95);
        nrfiProb = nrfi / 100;
        inner += probBarHtml("YRFI 首局有得分", "NRFI 首局無得分", 100 - nrfi, nrfi);

        var fiRows = "";
        function fiRow(name, fi) {
          if (!fi) return "";
          return '<tr><td>' + esc(name) + '</td>' +
            '<td>' + fi.off + ' / ' + fi.n + '(' + Math.round(fi.offRate * 100) + '%)</td>' +
            '<td>' + fi.def + ' / ' + fi.n + '(' + Math.round(fi.defRate * 100) + '%)</td></tr>';
        }
        fiRows += fiRow(game.away.name, awayFi) + fiRow(game.home.name, homeFi);
        var nGames = (awayFi || homeFi).n;
        if (fiRows) {
          inner += '<div class="table-wrap" style="margin-top:10px"><table class="stat-table" style="min-width:320px">' +
            '<tr><th>近 ' + nGames + ' 場</th><th>首局有得分</th><th>首局有失分</th></tr>' + fiRows + '</table></div>';
        }

        var fiNotes = [];
        function p1Note(p, st) {
          if (!p || !st || !st.era) return;
          var seasonSt = statsById[p.id] || {};
          var line = esc(p.fullName) + " 首局 ERA <b>" + esc(st.era) + "</b>(共 " + esc(st.inningsPitched || "-") + " 局,WHIP " + esc(st.whip || "-") + ")";
          var sEra = seasonSt.era ? Number(seasonSt.era) : null;
          var fEra = Number(st.era);
          if (sEra !== null && !isNaN(fEra)) {
            var diff = fEra - sEra;
            if (diff > 0.75) line += ",明顯高於其球季 ERA " + esc(seasonSt.era) + ",開局偏不穩";
            else if (diff < -0.75) line += ",低於其球季 ERA " + esc(seasonSt.era) + ",開局表現穩健";
            else line += ",與其球季 ERA " + esc(seasonSt.era) + " 相近";
          }
          if (p1Adj[p.id]) line += "(已計入 NRFI " + p1Adj[p.id] + " 調整)";
          else if (!isNaN(fEra) && (fEra <= 2.0 || fEra >= 6.0)) line += "(首局樣本不足 8 局,不列入機率調整)";
          fiNotes.push("<p>" + line + "。</p>");
        }
        p1Note(pp.away, awayP1);
        p1Note(pp.home, homeP1);
        if (parkFiAdjPct) {
          fiNotes.push("<p>球場「" + esc(venueName) + "」" + (parkFiAdjPct < 0 ? "偏打者向" : "偏投手向") +
            "(NRFI " + (parkFiAdjPct >= 0 ? "+" : "") + parkFiAdjPct.toFixed(1) + "%)。</p>");
        }
        if (weatherFiAdjPct) {
          fiNotes.push("<p>" + (weatherFiAdjPct < 0 ? "天氣條件(高溫或強風吹向外野)對進攻有利" : "強風吹向內野抑制打擊") +
            "(NRFI " + (weatherFiAdjPct >= 0 ? "+" : "") + weatherFiAdjPct.toFixed(1) + "%)。</p>");
        }
        fiNotes.push('<p>綜合兩隊近況估算,本場 <b>NRFI(首局雙方皆未得分)機率約 ' + Math.round(nrfi) + '%</b>。</p>');
        inner += '<div class="analysis-box" style="margin-top:10px">' + fiNotes.join("") + '</div>' +
          '<div class="detail-note">依兩隊近 ' + nGames + ' 場首局得失分與先發投手首局分項數據之簡易估算,僅供參考。</div>';

        html += sectionBlock("首局得失分分析(NRFI / YRFI)", inner);
      }

      // American odds analysis (model vs. market implied probability)
      var oa = oddsImpliedAnalysis(game.odds);
      if (oa) {
        var oaInner = oa.tableHtml;
        var oaNotes = [oa.vigNote];

        // model home win prob: record share + last-10 share + starter ERA edge + home advantage
        var modelH = null;
        if (ar && hr) {
          var comps = [];
          var aP = Number(ar.pct), hP = Number(hr.pct);
          if (aP + hP > 0) comps.push(hP / (aP + hP));
          function l10rate(f) {
            if (!f || !f.lastTen) return null;
            var parts = f.lastTen.split("-");
            var w = Number(parts[0]), l = Number(parts[1]);
            return (w + l) > 0 ? w / (w + l) : null;
          }
          var aL10 = l10rate(aForm), hL10 = l10rate(hForm);
          if (aL10 !== null && hL10 !== null && aL10 + hL10 > 0) comps.push(hL10 / (aL10 + hL10));
          if (comps.length) {
            modelH = comps.reduce(function (x, y) { return x + y; }, 0) / comps.length;
            var aEraN = aSt && aSt.era ? Number(aSt.era) : NaN;
            var hEraN = hSt && hSt.era ? Number(hSt.era) : NaN;
            if (!isNaN(aEraN) && !isNaN(hEraN)) {
              modelH += clampNum((aEraN - hEraN) * 0.04, -0.06, 0.06);
            }
            if (hForm && hForm.homeWinPct !== null && hForm.homeWinPct !== undefined && hForm.homeWinPct > 0.6) {
              modelH += 0.035; // home advantage — only when the home team actually wins more at home
            }
            modelH = clampNum(modelH, 0.05, 0.95);
          }
        }

        if (modelH !== null) {
          var edgeH = modelH - oa.fairH, edgeA = (1 - modelH) - oa.fairA;
          oaNotes.push("<p>模型估計:主隊勝率 <b>" + pctStr(modelH) + "</b>,市場隱含機率 " + pctStr(oa.fairH) +
            "(差距 " + (edgeH >= 0 ? "+" : "") + (edgeH * 100).toFixed(1) + "%);客隊 <b>" + pctStr(1 - modelH) +
            "</b>,市場隱含機率 " + pctStr(oa.fairA) + "(差距 " + (edgeA >= 0 ? "+" : "") + (edgeA * 100).toFixed(1) + "%)。</p>");
        }

        oaInner += '<div class="analysis-box" style="margin-top:10px">' + oaNotes.join("") + '</div>' +
          '<div class="detail-note">模型為戰績/近十場/先發投手之簡易統計推估,與市場數據比較僅供參考。</div>';
        html += sectionBlock("美式賠率分析", oaInner);
      }

      // game-total (大小分) odds analysis
      var od = game.odds;
      var totLine = null, oPrice = null, uPrice = null;
      if (od) {
        if (od.over && od.over.line) {
          var tl = Number(stripOU(od.over.line));
          if (isFinite(tl) && tl > 0) {
            totLine = tl;
            oPrice = od.over.cur || null;
            uPrice = (od.under && od.under.cur) || null;
          }
        }
        if (totLine === null && od.overUnder !== null && od.overUnder !== undefined) {
          var tl2 = Number(od.overUnder);
          if (isFinite(tl2) && tl2 > 0) totLine = tl2;
        }
      }
      var aStT = pp.away ? (statsById[pp.away.id] || {}) : {};
      var hStT = pp.home ? (statsById[pp.home.id] || {}) : {};
      var totVenue = gd.venue && gd.venue.name;
      var parkRunAdj = parkTotalRunAdj(totVenue);
      var weatherRunAdj = weatherTotalRunAdj(gd.weather);
      var aBullEra = bullpenMap[awayTeamId], hBullEra = bullpenMap[homeTeamId];
      var bullVals = Object.keys(bullpenMap).map(function (id) { return bullpenMap[id]; }).filter(function (v) { return isFinite(v) && v > 0; });
      var dynLeagueBullEra = bullVals.length ? bullVals.reduce(function (a, b) { return a + b; }, 0) / bullVals.length : LEAGUE_ERA;
      var expTot = expectedTotalRuns(awayFi, homeFi, aStT.era, hStT.era, dynLeagueEra, parkRunAdj, weatherRunAdj,
        awayOff, homeOff, aBullEra, hBullEra, dynLeagueBullEra);
      if (totLine !== null && expTot !== null) {
        var pOver = overProbOf(expTot, totLine);
        var priceReal = !!(oPrice && uPrice);
        var beO = impliedProb(oPrice || "-110"), beU = impliedProb(uPrice || "-110");
        var inner2 = probBarHtml("大分 Over " + totLine, "小分 Under " + totLine, pOver * 100, (1 - pOver) * 100);
        function ouRow(label, price, be, prob) {
          var edge = prob - be;
          return '<tr><td>' + label + '</td><td>' + esc(price) + '</td><td>' + (be !== null ? pctStr(be) : "-") + '</td>' +
            '<td><b>' + pctStr(prob) + '</b></td>' +
            '<td class="' + (edge >= 0 ? "pos" : "neg") + '"><b>' + (edge >= 0 ? "+" : "") + (edge * 100).toFixed(1) + '%</b></td></tr>';
        }
        inner2 += '<div class="table-wrap" style="margin-top:10px"><table class="stat-table" style="min-width:380px">' +
          '<tr><th>方向</th><th>賠率</th><th>損益兩平</th><th>模型機率</th><th>優勢</th></tr>' +
          ouRow("大分 Over " + totLine, oPrice || "-110(參考)", beO, pOver) +
          ouRow("小分 Under " + totLine, uPrice || "-110(參考)", beU, 1 - pOver) +
          '</table></div>';
        var ouNotes = [];
        if (awayFi && homeFi && awayFi.rsAvg !== null && homeFi.rsAvg !== null) {
          ouNotes.push("<p>客隊近 " + awayFi.n + " 場平均得 <b>" + awayFi.rsAvg.toFixed(1) + "</b> 分/失 " + awayFi.raAvg.toFixed(1) +
            " 分;主隊近 " + homeFi.n + " 場平均得 <b>" + homeFi.rsAvg.toFixed(1) + "</b> 分/失 " + homeFi.raAvg.toFixed(1) + " 分。</p>");
        }
        if (pp.away && pp.home && (aStT.era || hStT.era)) {
          ouNotes.push("<p>先發 ERA:" + esc(pp.away.fullName) + " <b>" + esc(aStT.era || "-") + "</b> vs " +
            esc(pp.home.fullName) + " <b>" + esc(hStT.era || "-") + "</b>,對照聯盟平均 " + dynLeagueEra.toFixed(2) + "(依今日先發投手池計算)已計入總分調整。</p>");
        }
        if (isFinite(aBullEra) && isFinite(hBullEra)) {
          ouNotes.push("<p>牛棚 ERA:客 <b>" + aBullEra.toFixed(2) + "</b> vs 主 <b>" + hBullEra.toFixed(2) +
            "</b>,對照聯盟牛棚平均 " + dynLeagueBullEra.toFixed(2) + " 已計入總分調整。</p>");
        }
        if (homeOff || awayOff) {
          var moMatchupParts = [];
          if (homeOff) moMatchupParts.push("主隊打線對 " + esc(pp.away.fullName) + " 生涯合計打擊率 " + homeOff.avg.toFixed(3) + "(" + homeOff.atBats + " 打數)");
          if (awayOff) moMatchupParts.push("客隊打線對 " + esc(pp.home.fullName) + " 生涯合計打擊率 " + awayOff.avg.toFixed(3) + "(" + awayOff.atBats + " 打數)");
          ouNotes.push("<p>先發對戰數據:" + moMatchupParts.join(";") + ",已計入總分調整。</p>");
        }
        if (parkRunAdj) {
          ouNotes.push("<p>球場「" + esc(totVenue) + "」" + (parkRunAdj > 0 ? "偏打者向,總分預期 +" : "偏投手向,總分預期 ") +
            parkRunAdj.toFixed(1) + " 分。</p>");
        }
        if (weatherRunAdj) {
          ouNotes.push("<p>天氣條件" + (weatherRunAdj > 0 ? "有利進攻,總分預期 +" : "抑制進攻,總分預期 ") +
            weatherRunAdj.toFixed(1) + " 分。</p>");
        }
        var edgeO2 = pOver - (beO === null ? 0.524 : beO), edgeU2 = (1 - pOver) - (beU === null ? 0.524 : beU);
        var leanOver = edgeO2 >= edgeU2;
        ouNotes.push("<p>模型預期總分 <b>" + expTot.toFixed(1) + "</b> 分 vs 盤口總分線 <b>" + totLine + "</b>," +
          "優勢較高的一邊為 <b>" + (leanOver ? "大分 Over" : "小分 Under") + "</b>(" +
          ((leanOver ? edgeO2 : edgeU2) >= 0 ? "+" : "") + ((leanOver ? edgeO2 : edgeU2) * 100).toFixed(1) + "%)。</p>");
        if (!priceReal) ouNotes.push("<p>ESPN 目前僅提供總分線,大小分價位以常見 -110 參考水位估算,開盤後請以實際賠率為準。</p>");
        inner2 += '<div class="analysis-box" style="margin-top:10px">' + ouNotes.join("") + '</div>' +
          '<div class="detail-note">預期總分以兩隊近況得失分、先發 ERA、牛棚 ERA、先發對戰數據推估,並以常態分布(σ≈' + TOTAL_SD + ')換算大小分機率,僅供參考。</div>';
        html += sectionBlock("大小分(全場總分)賠率分析", inner2);
      }

      html += oddsDetailHtml(game);
      body.innerHTML = html;
    });
  }

  // ---------- NBA detail ----------
  function renderNbaDetail(game, body) {
    return fetchJson("https://site.api.espn.com/apis/site/v2/sports/basketball/" + game.league + "/summary?event=" + game.espnId).then(function (s) {
      var comp = (s.header && s.header.competitions && s.header.competitions[0]) || {};
      var competitors = comp.competitors || [];
      var homeC = competitors.find(function (c) { return c.homeAway === "home"; }) || {};
      var awayC = competitors.find(function (c) { return c.homeAway === "away"; }) || {};

      function rec(c) {
        var r = (c.record || []).find(function (x) { return x.type === "total"; }) || (c.record || [])[0];
        return r ? r.summary + "(勝-敗)" : "";
      }
      var html = detailHeaderHtml(game, rec(awayC), rec(homeC));

      html += nbaPreviewSections(game, s, awayC, homeC);
      html += oddsDetailHtml(game);
      body.innerHTML = html;
    });
  }

  function nbaPreviewSections(game, s, awayC, homeC) {
    var html = "";

    var pred = s.predictor;
    var aProj = pred && pred.awayTeam && parseFloat(pred.awayTeam.gameProjection);
    var hProj = pred && pred.homeTeam && parseFloat(pred.homeTeam.gameProjection);
    if (aProj && hProj) {
      html += sectionBlock("ESPN 勝率預測", probBarHtml(game.away.name, game.home.name, aProj, hProj));
    }

    var series = s.seasonseries && s.seasonseries[0];
    var analysis = [];
    if (series && series.summary) {
      analysis.push("本季對戰:<b>" + esc(series.summary) + "</b>" + (series.seriesScore ? "(" + esc(series.seriesScore) + ")" : "") + "。");
    }
    function recSummary(c) {
      var r = (c.record || []).find(function (x) { return x.type === "total"; }) || (c.record || [])[0];
      return r ? r.summary : null;
    }
    var ar = recSummary(awayC), hr = recSummary(homeC);
    if (ar && hr) {
      analysis.push("戰績:<b>" + esc(game.away.name) + "</b> " + esc(ar) + ",<b>" + esc(game.home.name) + "</b> " + esc(hr) + "。");
    }
    if (analysis.length) {
      html += sectionBlock("賽前分析", '<div class="analysis-box">' + analysis.map(function (p) { return "<p>" + p + "</p>"; }).join("") + '</div>');
    }

    if (s.article && s.article.headline) {
      var desc = s.article.description ? "<p>" + esc(s.article.description) + "</p>" : "";
      html += sectionBlock("賽事焦點(ESPN)",
        '<div class="analysis-box"><p><b>' + esc(s.article.headline) + '</b></p>' + desc + '</div>');
    }

    var injuries = s.injuries || [];
    var iRows = "";
    injuries.forEach(function (teamInj) {
      (teamInj.injuries || []).forEach(function (inj) {
        iRows += '<li><span>' + esc(teamInj.team ? teamInj.team.abbreviation : "") + " " +
          esc(inj.athlete ? inj.athlete.displayName : "") + '</span><span class="injury-status">' + esc(inj.status || "") + '</span></li>';
      });
    });
    if (iRows) html += sectionBlock("傷兵名單", '<ul class="injury-list">' + iRows + '</ul>');

    // American odds analysis (model = ESPN predictor when available)
    var oa = oddsImpliedAnalysis(game.odds);
    if (oa) {
      var oaInner = oa.tableHtml;
      var oaNotes = [oa.vigNote];
      if (aProj && hProj && aProj + hProj > 0) {
        var modelH = hProj / (aProj + hProj);
        var edgeH = modelH - oa.fairH, edgeA = (1 - modelH) - oa.fairA;
        oaNotes.push("<p>ESPN 預測:主隊勝率 <b>" + pctStr(modelH) + "</b>,市場隱含機率 " + pctStr(oa.fairH) +
          "(差距 " + (edgeH >= 0 ? "+" : "") + (edgeH * 100).toFixed(1) + "%);客隊 <b>" + pctStr(1 - modelH) +
          "</b>,市場隱含機率 " + pctStr(oa.fairA) + "(差距 " + (edgeA >= 0 ? "+" : "") + (edgeA * 100).toFixed(1) + "%)。</p>");
        if (edgeH >= edgeA && edgeH > 0.02) {
          oaNotes.push("<p>模型預測:<b>" + esc(game.home.name) + "</b> 勝率 " + pctStr(modelH) + ",高於市場隱含機率 " + pctStr(oa.fairH) + "。</p>");
        } else if (edgeA > edgeH && edgeA > 0.02) {
          oaNotes.push("<p>模型預測:<b>" + esc(game.away.name) + "</b> 勝率 " + pctStr(1 - modelH) + ",高於市場隱含機率 " + pctStr(oa.fairA) + "。</p>");
        } else {
          oaNotes.push("<p>模型預測與市場隱含機率接近,無明顯落差。</p>");
        }
      }
      oaInner += '<div class="analysis-box" style="margin-top:10px">' + oaNotes.join("") + '</div>' +
        '<div class="detail-note">以 ESPN 勝率預測與市場隱含機率比較,僅供參考。</div>';
      html += sectionBlock("美式賠率分析", oaInner);
    }

    if (!html) {
      html = sectionBlock("賽前資訊", '<div class="analysis-box"><p>暫無更多賽前資料,開賽後將顯示逐節比分與球員數據。</p></div>');
    }
    return html;
  }

  // ---------- modal control ----------
  var DETAIL_RENDERERS = { mlb: renderMlbDetail, nba: renderNbaDetail, wnba: renderNbaDetail };

  function loadDetail(game) {
    var body = document.getElementById("modalBody");
    return DETAIL_RENDERERS[game.league](game, body).then(function () {
      hydrateOddsHistory(game);
    }).catch(function (err) {
      body.innerHTML = detailHeaderHtml(game, null, null) +
        '<div class="error-state">詳細資料載入失敗:' + esc(err.message || err) +
        '<br><button onclick="window.__scoreApp.reloadDetail()">重試</button></div>';
    });
  }

  function openDetail(game) {
    modal.game = game;
    var m = document.getElementById("modal");
    m.classList.remove("hidden");
    m.setAttribute("aria-hidden", "false");
    document.body.style.overflow = "hidden";
    document.getElementById("modalBody").innerHTML =
      detailHeaderHtml(game, null, null) +
      '<div class="detail-loading"><div class="spinner"></div>載入詳細資料中…</div>';
    loadDetail(game);
  }

  function closeDetail() {
    modal.game = null;
    var m = document.getElementById("modal");
    m.classList.add("hidden");
    m.setAttribute("aria-hidden", "true");
    document.body.style.overflow = "";
  }

  // ---------- controls ----------
  function setFilter(key) {
    state.filter = key;
    document.querySelectorAll(".tab").forEach(function (t) {
      t.classList.toggle("active", t.dataset.league === key);
    });
    loadAll();
  }

  function clearGames() {
    LEAGUE_ORDER.forEach(function (k) {
      state.gamesByLeague[k] = [];
      state.errorByLeague[k] = null;
    });
  }

  function shiftDate(days) {
    var d = new Date(state.date);
    d.setDate(d.getDate() + days);
    state.date = d;
    clearGames();
    loadAll();
  }

  function goToday() {
    state.date = new Date();
    clearGames();
    loadAll();
  }

  function retryLeague(key) {
    state.errorByLeague[key] = null;
    render();
    loadLeague(key).then(function () { render(); });
  }

  function setNotifyButton() {
    var btn = document.getElementById("notifBtn");
    btn.textContent = state.notify ? "🔔" : "🔕";
    btn.title = state.notify ? "比分變動通知:開啟(點擊關閉)" : "比分變動通知:關閉(點擊開啟)";
  }

  function init() {
    cleanupOddsLogs();

    document.getElementById("leagueTabs").addEventListener("click", function (e) {
      var btn = e.target.closest(".tab");
      if (btn) setFilter(btn.dataset.league);
    });
    document.getElementById("prevDay").addEventListener("click", function () { shiftDate(-1); });
    document.getElementById("nextDay").addEventListener("click", function () { shiftDate(1); });
    document.getElementById("dateLabel").addEventListener("click", goToday);
    document.getElementById("refreshBtn").addEventListener("click", function (e) {
      e.currentTarget.classList.add("spinning");
      loadAll().then(function () {
        var b = document.getElementById("refreshBtn");
        if (b) b.classList.remove("spinning");
      });
    });
    document.getElementById("notifBtn").addEventListener("click", function () {
      if (state.notify) {
        state.notify = false;
        store.set("notif", "0");
        setNotifyButton();
        return;
      }
      if (typeof Notification === "undefined") return;
      Notification.requestPermission().then(function (p) {
        state.notify = p === "granted";
        store.set("notif", state.notify ? "1" : "0");
        setNotifyButton();
      });
    });
    document.getElementById("themeBtn").addEventListener("click", function () {
      var root = document.documentElement;
      var current = root.getAttribute("data-theme") ||
        (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
      var next = current === "dark" ? "light" : "dark";
      root.setAttribute("data-theme", next);
      store.set("scoreapp-theme", next);
      document.getElementById("themeBtn").textContent = next === "dark" ? "🌙" : "☀️";
    });

    // card click: pin toggle or open detail
    document.getElementById("content").addEventListener("click", function (e) {
      var pin = e.target.closest(".pin-btn");
      if (pin) {
        togglePin(pin.dataset.pin);
        LEAGUE_ORDER.forEach(function (k) {
          state.gamesByLeague[k].sort(function (a, b) {
            var pa = pinSet.has(a.id) ? 0 : 1, pb = pinSet.has(b.id) ? 0 : 1;
            if (pa !== pb) return pa - pb;
            var order = { live: 0, scheduled: 1, final: 2, postponed: 3 };
            if (order[a.status] !== order[b.status]) return order[a.status] - order[b.status];
            return new Date(a.startTime) - new Date(b.startTime);
          });
        });
        render();
        return;
      }
      var card = e.target.closest(".game-card.clickable");
      if (!card) return;
      var game = findGame(card.dataset.gid);
      if (game) openDetail(game);
    });
    document.getElementById("modalClose").addEventListener("click", closeDetail);
    document.getElementById("modalBackdrop").addEventListener("click", closeDetail);

    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && modal.game) closeDetail();
    });

    var savedTheme = store.get("scoreapp-theme");
    if (savedTheme) {
      document.documentElement.setAttribute("data-theme", savedTheme);
      document.getElementById("themeBtn").textContent = savedTheme === "dark" ? "🌙" : "☀️";
    }
    state.notify = store.get("notif") === "1" && canNotify();
    setNotifyButton();

    window.__scoreApp = {
      retryLeague: retryLeague,
      reloadDetail: function () { if (modal.game) openDetail(modal.game); },
    };

    // instant paint from last snapshot, then refresh
    if (restoreSnapshot()) render();
    loadAll().then(openGameFromQuery);
  }

  // deep link from other pages (e.g. line-direction.html): ?game=<id> opens
  // that game's detail modal once today's games have loaded
  function openGameFromQuery() {
    var gid;
    try { gid = new URLSearchParams(location.search).get("game"); } catch (e) { return; }
    if (!gid) return;
    var g = findGame(gid);
    if (g) openDetail(g);
  }

  document.addEventListener("DOMContentLoaded", init);
})();
