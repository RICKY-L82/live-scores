(function () {
  "use strict";

  // Standalone page: aggregates market movement (moneyline + total-line) across
  // today's whole MLB/NBA/WNBA slate. Reuses the server-collected
  // data/odds/<league>.json history (see scripts/collect-odds.js) that the
  // game-detail modal in app.js already draws its per-game "市場動向" note
  // from, but rolls every scanned game up into one page-level summary.

  // ---------- helpers (mirrors assets/js/app.js / picks.js) ----------
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
  // vig-free probabilities from a two-way moneyline
  function fairProbs(mlA, mlH) {
    var a = impliedProb(mlA), h = impliedProb(mlH);
    if (a === null || h === null || a + h === 0) return null;
    return { away: a / (a + h), home: h / (a + h) };
  }
  function usTodayISO() {
    return new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(new Date());
  }

  // ---------- today's not-yet-started games (MLB schedule + ESPN NBA/WNBA) ----------
  function fetchMlbGames() {
    var today = usTodayISO();
    return fetchJson("https://statsapi.mlb.com/api/v1/schedule?sportId=1&date=" + today)
      .then(function (data) {
        var games = [];
        (data.dates || []).forEach(function (d) {
          (d.games || []).forEach(function (g) {
            var status = g.status || {};
            // include the whole day's slate (not just not-yet-started games) so
            // the line-direction history stays visible for 走地 reference after
            // a game goes live or finishes; only drop games that never traded
            if (!/Postponed|Suspended|Cancelled/i.test(status.detailedState || "")) {
              games.push({
                league: "MLB", away: g.teams.away.team.name, home: g.teams.home.team.name,
                start: g.gameDate, gid: "mlb-" + g.gamePk,
              });
            }
          });
        });
        return games;
      })
      .catch(function () { return []; });
  }
  function fetchEspnGames(leagueKey, leagueLabel) {
    var ymd = usTodayISO().replace(/-/g, "");
    var url = "https://site.api.espn.com/apis/site/v2/sports/basketball/" + leagueKey + "/scoreboard?dates=" + ymd;
    return fetchJson(url)
      .then(function (data) {
        return (data.events || []).filter(function (ev) {
          var st = ev.competitions && ev.competitions[0] && ev.competitions[0].status;
          // keep live/final games too — see fetchMlbGames comment
          return !(st && st.type && /postponed|cancel/i.test(st.type.name || ""));
        }).map(function (ev) {
          var comp = ev.competitions[0];
          var home = (comp.competitors || []).find(function (c) { return c.homeAway === "home"; });
          var away = (comp.competitors || []).find(function (c) { return c.homeAway === "away"; });
          return {
            league: leagueLabel, away: away.team.displayName, home: home.team.displayName,
            start: ev.date, gid: leagueKey + "-" + ev.id,
          };
        });
      })
      .catch(function () { return []; });
  }
  // KBO/NPB have no ESPN feed; their schedule comes from The Odds API's
  // events-only endpoint (no markets param = free, doesn't touch the shared
  // quota) — mirrors assets/js/picks.js's key handling (two keys with
  // fallback, unless the user set their own via the picks.html 🔑 link) so a
  // key set there is honored here too.
  var DEFAULT_ODDS_API_KEYS = ["3fc688e03b27b3d41eb04f761c7f58c3", "78782417cf4202b1e74da436e45b3ecd", "7d1f6397f3aa8d041a767e5dcb440d97", "b998595122a6efd15f322466e21ee2b5"];
  function getOddsApiKeys() {
    try {
      var override = localStorage.getItem("oddsApiKey");
      return override ? [override] : DEFAULT_ODDS_API_KEYS;
    } catch (e) { return DEFAULT_ODDS_API_KEYS; }
  }
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
  function fetchOddsApiGames(sportKey, leagueLabel) {
    if (!getOddsApiKeys().length) return Promise.resolve([]);
    return fetchOddsApiWithFallback(function (key) {
      return "https://api.the-odds-api.com/v4/sports/" + sportKey + "/events?apiKey=" + encodeURIComponent(key);
    })
      .then(function (events) {
        // no "live/final" filtering here: The Odds API's free /events endpoint
        // only lists upcoming (and still-live) events itself, so whatever it
        // returns today is fair game — see fetchMlbGames comment
        return (events || []).filter(function (ev) {
          return !!ev.commence_time;
        }).map(function (ev) {
          return {
            league: leagueLabel, away: ev.away_team, home: ev.home_team,
            start: ev.commence_time, gid: leagueLabel.toLowerCase() + "-" + ev.id,
          };
        });
      })
      .catch(function () { return []; });
  }

  // ---------- market movement aggregation ----------
  var lineHistCache = {};
  function fetchLineHistFile(league) {
    var c = lineHistCache[league];
    if (c && Date.now() - c.t < 240000) return Promise.resolve(c.data);
    return fetchJson("data/odds/" + league + ".json?t=" + Math.floor(Date.now() / 240000))
      .then(function (d) { lineHistCache[league] = { t: Date.now(), data: d }; return d; })
      .catch(function () { return c ? c.data : null; });
  }
  function findLineHistEntry(data, awayName, homeName, startIso) {
    if (!data || !data.events) return null;
    var key = awayName + "|" + homeName, hit = null;
    Object.keys(data.events).forEach(function (id) {
      var e = data.events[id];
      if (e.key !== key) return;
      // same matchup can repeat within a series; require the same local date
      if (startIso && e.date && toISODate(new Date(e.date)) !== toISODate(new Date(startIso))) return;
      hit = e;
    });
    return hit;
  }
  function isUsableOdds(v) {
    if (v === undefined || v === null) return false;
    var n = Number(String(v).replace(/^\+/, ""));
    return isFinite(n) && n !== 0;
  }
  // earliest and latest recorded snapshot where both fields are priced
  function firstLastPair(snaps, keyA, keyB) {
    var first = null, last = null;
    for (var i = 0; i < snaps.length; i++) {
      var s = snaps[i];
      if (isUsableOdds(s[keyA]) && isUsableOdds(s[keyB])) {
        if (!first) first = s;
        last = s;
      }
    }
    return (first && last && first !== last) ? { first: first, last: last } : null;
  }
  // percentage-point shift of keyB's vig-free share from first snapshot to last
  // (positive => the keyB side is gaining money/market confidence)
  function pairShift(snaps, keyA, keyB) {
    var fl = firstLastPair(snaps, keyA, keyB);
    if (!fl) return null;
    var f0 = fairProbs(fl.first[keyA], fl.first[keyB]);
    var f1 = fairProbs(fl.last[keyA], fl.last[keyB]);
    if (!f0 || !f1) return null;
    return (f1.home - f0.home) * 100;
  }
  // sign of the total *line*'s own movement (>0 raised => over favoured, <0
  // lowered => under favoured). When the number itself moves, comparing raw
  // O/U prices across two different lines is misleading (a shorter Over price
  // at a lower total can be pure math, not fresh money), so this takes
  // priority over the vig-free price shift whenever the line actually moved.
  function totalLineDir(snaps) {
    var withTot = snaps.filter(function (s) { return isUsableOdds(s.tot); });
    if (withTot.length < 2) return null;
    var t0 = Number(withTot[0].tot), t1 = Number(withTot[withTot.length - 1].tot);
    if (!isFinite(t0) || !isFinite(t1) || t0 === t1) return null;
    return { d: t1 - t0, from: t0, to: t1 };
  }

  function leagueFileKey(lg) {
    if (lg === "NBA") return "nba";
    if (lg === "WNBA") return "wnba";
    if (lg === "KBO") return "kbo";
    if (lg === "NPB") return "npb";
    return "mlb";
  }

  function collectLineDirection(games) {
    var wantLeagues = {};
    games.forEach(function (g) { wantLeagues[leagueFileKey(g.league)] = true; });
    return Promise.all(Object.keys(wantLeagues).map(function (lg) {
      return fetchLineHistFile(lg).then(function (d) { return { lg: lg, d: d }; });
    })).then(function (files) {
      var byLeague = {};
      files.forEach(function (f) { byLeague[f.lg] = f.d; });
      var mlMoves = [], totMoves = [], lineMoves = [];
      games.forEach(function (g) {
        var data = byLeague[leagueFileKey(g.league)];
        var entry = findLineHistEntry(data, g.away, g.home, g.start);
        if (!entry || !entry.snaps || entry.snaps.length < 2) return;
        var mlD = pairShift(entry.snaps, "mlA", "mlH"); // >0 home gaining, <0 away gaining
        if (mlD !== null && Math.abs(mlD) >= 1) {
          mlMoves.push({ away: g.away, home: g.home, league: g.league, gid: g.gid, d: mlD });
        }
        var totPriceD = pairShift(entry.snaps, "uO", "oO"); // >0 over gaining, <0 under gaining
        var lineDir = totalLineDir(entry.snaps); // >0 line raised, <0 line lowered
        var totD, lineFrom = null, lineTo = null;
        if (lineDir !== null) {
          // the total number moved: trust its direction, keep the price
          // shift's magnitude when available so the badge stays comparable
          var mag = totPriceD !== null ? Math.abs(totPriceD) : Math.abs(lineDir.d) * 10;
          totD = lineDir.d > 0 ? mag : -mag;
          lineFrom = lineDir.from;
          lineTo = lineDir.to;
          lineMoves.push({
            away: g.away, home: g.home, league: g.league, gid: g.gid,
            d: lineDir.d, from: lineDir.from, to: lineDir.to,
          });
        } else {
          totD = totPriceD;
        }
        if (totD !== null && Math.abs(totD) >= 1) {
          totMoves.push({ away: g.away, home: g.home, league: g.league, gid: g.gid, d: totD, lineFrom: lineFrom, lineTo: lineTo });
        }
      });
      return { mlMoves: mlMoves, totMoves: totMoves, lineMoves: lineMoves, scanned: games.length };
    }).catch(function () { return { mlMoves: [], totMoves: [], lineMoves: [], scanned: games.length }; });
  }

  // ---------- render ----------
  function gameHref(gid) {
    // index.html's game-detail modal only knows MLB/NBA/WNBA — KBO/NPB games
    // render as plain (non-clickable) rows instead of linking to a page that
    // can't show them
    if (!gid || gid.indexOf("kbo-") === 0 || gid.indexOf("npb-") === 0) return null;
    return "index.html?game=" + encodeURIComponent(gid);
  }
  // wraps a mover row's content in a link to that game's analysis page when
  // we have its id; falls back to a plain (non-clickable) row otherwise
  function moverLi(gid, inner) {
    var href = gameHref(gid);
    return href
      ? '<li><a class="dir-mover-link" href="' + esc(href) + '">' + inner + '</a></li>'
      : '<li>' + inner + '</li>';
  }
  function meter(label, leftN, rightN, leftLabel, rightLabel) {
    if (!leftN && !rightN) return "";
    return '<div class="dir-meter">' +
      '<div class="dir-meter-label"><span>' + label + '</span><span>' +
      leftLabel + ' <b>' + leftN + '</b>‧' + rightLabel + ' <b>' + rightN + '</b></span></div>' +
      '<div class="prob-bar"><div class="away-part" style="flex:' + (leftN || 0.001) + '"></div>' +
      '<div class="home-part" style="flex:' + (rightN || 0.001) + '"></div></div></div>';
  }

  function renderPanel(res) {
    var el = document.getElementById("lineDirContent");
    if (!res.scanned) {
      el.innerHTML = '<div class="empty-state">今天沒有可分析的賽事(休兵日,或賠率尚未開出)。<br>盤口通常於美東早上陸續開出,可稍後再回來看。</div>';
      return;
    }
    var html = '<div class="analysis-box"><p>已掃描 <b>' + res.scanned + '</b> 場今日賽事(MLB／NBA／WNBA／KBO／NPB,含已開打/已完賽,保留供走地參考),比對每場最早與最新一筆賠率紀錄' +
      '(MLB/NBA/WNBA 伺服器每 20 分鐘擷取一次;KBO/NPB 因共用 The Odds API 配額,每約 4 小時才擷取一次,且僅追蹤獨贏,無大小分/讓分走勢),統計資金與盤口越來越看好的方向。動能清單僅列出隱含機率變動 ≥1 個百分點的場次。</p></div>';

    if (!res.mlMoves.length && !res.totMoves.length && !res.lineMoves.length) {
      html += '<div class="empty-state">賠率歷史樣本不足或變動不明顯,稍後再回來看。</div>';
      el.innerHTML = html;
      return;
    }

    var homeN = res.mlMoves.filter(function (m) { return m.d > 0; }).length;
    var awayN = res.mlMoves.filter(function (m) { return m.d < 0; }).length;
    var overN = res.totMoves.filter(function (m) { return m.d > 0; }).length;
    var underN = res.totMoves.filter(function (m) { return m.d < 0; }).length;

    var movers = res.mlMoves.map(function (m) { return { away: m.away, home: m.home, gid: m.gid, d: m.d, kind: "ml" }; })
      .concat(res.totMoves.map(function (m) {
        return { away: m.away, home: m.home, gid: m.gid, d: m.d, kind: "tot", lineFrom: m.lineFrom, lineTo: m.lineTo };
      }));
    movers.sort(function (a, b) { return Math.abs(b.d) - Math.abs(a.d); });
    var moversHtml = movers.map(function (m) {
      var favSide, badgeClass, badgeText;
      if (m.kind === "ml") {
        favSide = m.d > 0 ? esc(m.home) + "(主)" : esc(m.away) + "(客)";
        badgeClass = m.d > 0 ? "home" : "away";
        badgeText = (m.d > 0 ? "📈主 " : "📈客 ") + Math.abs(m.d).toFixed(1);
      } else {
        favSide = m.d > 0 ? "大分 Over" : "小分 Under";
        badgeClass = m.d > 0 ? "over" : "under";
        badgeText = (m.d > 0 ? "📈大 " : "📈小 ") + Math.abs(m.d).toFixed(1);
      }
      var lineNote = (m.kind === "tot" && m.lineFrom !== null && m.lineFrom !== undefined && m.lineFrom !== m.lineTo)
        ? '<span class="dir-mover-line">總分線 ' + esc(m.lineFrom) + ' → ' + esc(m.lineTo) + '</span>'
        : "";
      return moverLi(m.gid, '<span class="move-badge ' + badgeClass + '">' + badgeText + '</span>' +
        '<div class="dir-mover-match">' + esc(m.away) + ' @ ' + esc(m.home) + '</div>' +
        '<div class="dir-mover-side">' + favSide + ' 越來越被看好' + lineNote + '</div>');
    }).join("");

    html += '<div class="detail-section"><h3>📈 資金與盤口動能</h3>' +
      meter("勝負盤(獨贏)", awayN, homeN, "客隊", "主隊") +
      meter("大小分", underN, overN, "小分", "大分") +
      (moversHtml ? '<ul class="dir-movers">' + moversHtml + '</ul>' : '<div class="empty-state">尚無明顯動能。</div>') +
      '</div>';

    var lineMoves = res.lineMoves.slice().sort(function (a, b) { return Math.abs(b.d) - Math.abs(a.d); });
    if (lineMoves.length) {
      var raisedN = lineMoves.filter(function (m) { return m.d > 0; }).length;
      var loweredN = lineMoves.filter(function (m) { return m.d < 0; }).length;
      var lineMovesHtml = lineMoves.map(function (m) {
        var up = m.d > 0;
        return moverLi(m.gid, '<span class="move-badge ' + (up ? "over" : "under") + '">' +
          (up ? "📈上調 " : "📉下調 ") + Math.abs(m.d).toFixed(1) + '</span>' +
          '<div class="dir-mover-match">' + esc(m.away) + ' @ ' + esc(m.home) + '</div>' +
          '<div class="dir-mover-side">總分線 ' + esc(m.from) + ' → ' + esc(m.to) + '</div>');
      }).join("");
      html += '<div class="detail-section"><h3>📏 總分線調整</h3>' +
        meter("總分線調整", loweredN, raisedN, "下調", "上調") +
        '<ul class="dir-movers">' + lineMovesHtml + '</ul>' +
        '</div>';
    }

    el.innerHTML = html;
  }

  function run() {
    var el = document.getElementById("lineDirContent");
    el.innerHTML = '<div class="detail-loading"><div class="spinner"></div>正在抓取今日賽程與盤口歷史,統計資金流向…</div>';
    document.getElementById("updatedAt").textContent = "計算中…";
    Promise.all([
      fetchMlbGames(),
      Promise.resolve([]), // NBA temporarily disabled — fetchEspnGames("nba", "NBA")
      fetchEspnGames("wnba", "WNBA"),
      fetchOddsApiGames("baseball_kbo", "KBO"),
      fetchOddsApiGames("baseball_npb", "NPB"),
    ]).then(function (res) {
      var games = res[0].concat(res[1]).concat(res[2]).concat(res[3]).concat(res[4]);
      return collectLineDirection(games);
    }).then(function (res) {
      renderPanel(res);
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
