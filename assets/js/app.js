(function () {
  "use strict";

  var LEAGUES = {
    mlb: { label: "MLB 美國職棒", color: "#d64545" },
    nba: { label: "NBA 美國職籃", color: "#e0762c" },
    npb: { label: "日職 NPB", color: "#3d7ab8" },
    kbo: { label: "韓職 KBO", color: "#4a9b6e" },
  };
  var LEAGUE_ORDER = ["mlb", "nba", "npb", "kbo"];
  var SPORTSDB_IDS = { npb: "4591", kbo: "4830" };

  var state = {
    date: new Date(),
    filter: "all",
    autoRefresh: true,
    notify: false,
    gamesByLeague: { mlb: [], nba: [], npb: [], kbo: [] },
    errorByLeague: { mlb: null, nba: null, npb: null, kbo: null },
    loading: true,
    changedIds: [],
    lastUpdatedStr: null,
  };

  var sched = { timeout: null, nextAt: 0 };
  var modal = { game: null, timer: null };
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

  function fetchNBA(dateStr) {
    var ymd = dateStr.replace(/-/g, "");
    var url = "https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard?dates=" + ymd;
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
          id: "nba-" + ev.id,
          league: "nba",
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

  function fetchSportsDBLeague(leagueKey, dateStr) {
    var leagueId = SPORTSDB_IDS[leagueKey];
    var url = "https://www.thesportsdb.com/api/v1/json/123/eventsday.php?d=" + dateStr + "&l=" + leagueId;
    return fetchJson(url).then(function (data) {
      var events = data.events || [];
      return events.map(function (e) {
        var raw = (e.strStatus || "").toUpperCase();
        var cat = "scheduled";
        if (["FT", "AOT", "AET", "CANC", "POST"].indexOf(raw) !== -1) cat = "final";
        else if (raw && raw !== "NS") cat = "live";

        // strTimestamp is UTC but has no zone marker; append Z so it converts to local time
        var ts = e.strTimestamp
          ? (e.strTimestamp.indexOf("Z") === -1 ? e.strTimestamp + "Z" : e.strTimestamp)
          : null;

        var detail;
        if (cat === "scheduled") {
          detail = ts ? formatTime(ts) : (e.strTime ? e.strTime.slice(0, 5) : "");
        } else if (cat === "live") {
          detail = e.strProgress || raw || "進行中";
        } else {
          detail = "已完賽";
        }

        var awayScore = e.intAwayScore !== null && e.intAwayScore !== undefined ? Number(e.intAwayScore) : null;
        var homeScore = e.intHomeScore !== null && e.intHomeScore !== undefined ? Number(e.intHomeScore) : null;

        return {
          id: leagueKey + "-" + e.idEvent,
          league: leagueKey,
          tsdbId: e.idEvent,
          raw: e,
          status: cat,
          detail: detail,
          startTime: ts,
          odds: null,
          away: { name: e.strAwayTeam, score: awayScore, logo: e.strAwayTeamBadge || null },
          home: { name: e.strHomeTeam, score: homeScore, logo: e.strHomeTeamBadge || null },
        };
      });
    });
  }

  var FETCHERS = {
    mlb: fetchMLB,
    nba: fetchNBA,
    npb: function (d) { return fetchSportsDBLeague("npb", d); },
    kbo: function (d) { return fetchSportsDBLeague("kbo", d); },
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
    var dateStr = toISODate(state.date);
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

  // ---------- adaptive refresh ----------
  function computeInterval() {
    var keys = state.filter === "all" ? LEAGUE_ORDER : [state.filter];
    var anyLive = false, anyPre = false;
    keys.forEach(function (k) {
      state.gamesByLeague[k].forEach(function (g) {
        if (g.status === "live") anyLive = true;
        if (g.status === "scheduled") anyPre = true;
      });
    });
    if (anyLive) return 10000;
    if (anyPre && isSameDay(state.date, new Date())) return 30000;
    return 60000;
  }

  function scheduleNext() {
    if (sched.timeout) clearTimeout(sched.timeout);
    sched.timeout = null;
    if (!state.autoRefresh) { sched.nextAt = 0; updateStatusText(); return; }
    var iv = computeInterval();
    sched.nextAt = Date.now() + iv;
    sched.timeout = setTimeout(function () {
      if (document.hidden) { scheduleNext(); return; }
      loadAll().then(scheduleNext);
    }, iv);
  }

  function updateStatusText() {
    var el = document.getElementById("updatedAt");
    if (!el) return;
    var txt = state.lastUpdatedStr ? "最後更新 " + state.lastUpdatedStr : "尚未更新";
    if (!state.autoRefresh) {
      txt += " · 自動更新關閉";
    } else if (sched.nextAt) {
      var s = Math.max(0, Math.round((sched.nextAt - Date.now()) / 1000));
      txt += " · " + s + " 秒後更新";
    }
    el.textContent = txt;
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
      if (sum) oddsHtml = '<div class="odds-row">' + sum + '</div>';
    }

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
        rows += '<tr><td>獨贏(客)' + '</td><td>' + openCell(od.mlAway) + '</td><td><b>' + cell(od.mlAway) + '</b></td></tr>';
        rows += '<tr><td>獨贏(主)' + '</td><td>' + openCell(od.mlHome) + '</td><td><b>' + cell(od.mlHome) + '</b></td></tr>';
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
        html += sectionBlock("盤口" + (od.provider ? "(" + od.provider + ")" : ""),
          '<div class="table-wrap"><table class="stat-table" style="min-width:320px">' +
          '<tr><th>市場</th><th>開盤</th><th>目前</th></tr>' + rows + '</table></div>' +
          '<div class="detail-note">美式賠率,僅供參考,不構成投注建議。</div>');
      }
    }

    var log = getOddsLog(game.id);
    if (log.length > 1) {
      var items = log.slice(-12).reverse().map(function (e) {
        return '<li><span class="mt">' + formatTime(new Date(e.t).toISOString()) + '</span><span>' + esc(e.s) + '</span></li>';
      }).join("");
      html += sectionBlock("盤口異動紀錄", '<ul class="move-list">' + items + '</ul>' +
        '<div class="detail-note">僅記錄本瀏覽器開啟頁面期間觀測到的變化。</div>');
    }
    return html;
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
            map[tr.team.id] = {
              streak: tr.streak ? tr.streak.streakCode : null,
              lastTen: lt ? lt.wins + "-" + lt.losses : null,
            };
          });
        });
        mlbFormCache = { t: Date.now(), map: map };
        return map;
      })
      .catch(function () { return {}; });
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

      if (game.status === "scheduled" || game.status === "postponed") {
        return renderMlbPreview(game, gd, ld, html, body);
      }

      // line score
      var ls = ld.linescore || {};
      var innings = ls.innings || [];
      if (innings.length > 0) {
        var head = '<tr><th>隊伍</th>';
        innings.forEach(function (inn) {
          var cls = (game.status === "live" && ls.currentInning === inn.num) ? ' class="current-inning"' : "";
          head += '<th' + cls + '>' + inn.num + '</th>';
        });
        head += '<th>R</th><th>H</th><th>E</th></tr>';

        function lsRow(name, side) {
          var row = '<tr><td>' + esc(name) + '</td>';
          innings.forEach(function (inn) {
            var v = inn[side] && inn[side].runs !== undefined ? inn[side].runs : "-";
            row += '<td>' + esc(v) + '</td>';
          });
          var tot = (ls.teams && ls.teams[side]) || {};
          row += '<td><b>' + esc(tot.runs !== undefined ? tot.runs : "-") + '</b></td>' +
                 '<td>' + esc(tot.hits !== undefined ? tot.hits : "-") + '</td>' +
                 '<td>' + esc(tot.errors !== undefined ? tot.errors : "-") + '</td></tr>';
          return row;
        }
        html += sectionBlock("逐局比分",
          '<div class="table-wrap"><table class="stat-table">' + head +
          lsRow(game.away.name, "away") + lsRow(game.home.name, "home") +
          '</table></div>');
      }

      // decisions
      var dec = ld.decisions;
      if (dec && (dec.winner || dec.loser || dec.save)) {
        var parts = [];
        if (dec.winner) parts.push("勝投 <b>" + esc(dec.winner.fullName) + "</b>");
        if (dec.loser) parts.push("敗投 <b>" + esc(dec.loser.fullName) + "</b>");
        if (dec.save) parts.push("救援 <b>" + esc(dec.save.fullName) + "</b>");
        html += sectionBlock("投手勝敗", '<div class="analysis-box"><p>' + parts.join("、") + '</p></div>');
      }

      // player stats
      var box = ld.boxscore && ld.boxscore.teams;
      if (box) {
        html += mlbBattingSection(game.away.name + " 打擊", box.away);
        html += mlbPitchingSection(game.away.name + " 投手", box.away);
        html += mlbBattingSection(game.home.name + " 打擊", box.home);
        html += mlbPitchingSection(game.home.name + " 投手", box.home);
      }

      html += oddsDetailHtml(game);
      body.innerHTML = html;
    });
  }

  function recordText(t) {
    var r = t && t.record && t.record.leagueRecord;
    if (!r) return "";
    return r.wins + "勝" + r.losses + "敗";
  }

  function mlbBattingSection(title, teamBox) {
    var ids = (teamBox && teamBox.batters) || [];
    if (!ids.length) return "";
    var rows = "";
    ids.forEach(function (pid) {
      var p = teamBox.players["ID" + pid];
      if (!p || !p.stats || !p.stats.batting || p.stats.batting.atBats === undefined) return;
      var b = p.stats.batting;
      if ((b.atBats || 0) === 0 && (b.baseOnBalls || 0) === 0 && (b.hitByPitch || 0) === 0 && (b.sacFlies || 0) === 0) return;
      var season = (p.seasonStats && p.seasonStats.batting) || {};
      rows += '<tr><td>' + esc(p.person.fullName) + ' <span class="starter-mark">' + esc(p.position ? p.position.abbreviation : "") + '</span></td>' +
        '<td>' + (b.atBats || 0) + '</td><td>' + (b.runs || 0) + '</td><td>' + (b.hits || 0) + '</td>' +
        '<td>' + (b.rbi || 0) + '</td><td>' + (b.baseOnBalls || 0) + '</td><td>' + (b.strikeOuts || 0) + '</td>' +
        '<td>' + esc(season.avg || "-") + '</td></tr>';
    });
    if (!rows) return "";
    return sectionBlock(title,
      '<div class="table-wrap"><table class="stat-table">' +
      '<tr><th>球員</th><th>打數</th><th>得分</th><th>安打</th><th>打點</th><th>四壞</th><th>三振</th><th>打擊率</th></tr>' +
      rows + '</table></div>');
  }

  function mlbPitchingSection(title, teamBox) {
    var ids = (teamBox && teamBox.pitchers) || [];
    if (!ids.length) return "";
    var rows = "";
    ids.forEach(function (pid) {
      var p = teamBox.players["ID" + pid];
      if (!p || !p.stats || !p.stats.pitching || p.stats.pitching.inningsPitched === undefined) return;
      var s = p.stats.pitching;
      var season = (p.seasonStats && p.seasonStats.pitching) || {};
      var note = s.note ? ' <span class="starter-mark">' + esc(s.note) + '</span>' : "";
      rows += '<tr><td>' + esc(p.person.fullName) + note + '</td>' +
        '<td>' + esc(s.inningsPitched || "0") + '</td><td>' + (s.hits || 0) + '</td><td>' + (s.runs || 0) + '</td>' +
        '<td>' + (s.earnedRuns || 0) + '</td><td>' + (s.baseOnBalls || 0) + '</td><td>' + (s.strikeOuts || 0) + '</td>' +
        '<td>' + esc(season.era || "-") + '</td></tr>';
    });
    if (!rows) return "";
    return sectionBlock(title,
      '<div class="table-wrap"><table class="stat-table">' +
      '<tr><th>球員</th><th>局數</th><th>被安打</th><th>失分</th><th>自責分</th><th>四壞</th><th>三振</th><th>ERA</th></tr>' +
      rows + '</table></div>');
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
      rows += '<tr><td>' + (orderNum / 100) + '. ' + esc(p.person.fullName) +
        ' <span class="starter-mark">' + esc(p.position ? p.position.abbreviation : "") + '</span></td></tr>';
    });
    if (!rows) return "";
    return '<div><div class="detail-note" style="margin:0 0 4px"><b>' + esc(title) + '</b></div>' +
      '<div class="table-wrap"><table class="stat-table" style="min-width:0">' + rows + '</table></div></div>';
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

    return Promise.all([getMlbForm(), Promise.all(statFetches)]).then(function (results) {
      var formMap = results[0];
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
      if (box) {
        var awayLineup = mlbLineupSection(game.away.name, box.away);
        var homeLineup = mlbLineupSection(game.home.name, box.home);
        if (awayLineup || homeLineup) {
          html += sectionBlock("先發打線(已公布)",
            '<div class="lineup-grid">' + awayLineup + homeLineup + '</div>');
        }
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

      html += oddsDetailHtml(game);
      body.innerHTML = html;
    });
  }

  // ---------- NBA detail ----------
  function renderNbaDetail(game, body) {
    return fetchJson("https://site.api.espn.com/apis/site/v2/sports/basketball/nba/summary?event=" + game.espnId).then(function (s) {
      var comp = (s.header && s.header.competitions && s.header.competitions[0]) || {};
      var competitors = comp.competitors || [];
      var homeC = competitors.find(function (c) { return c.homeAway === "home"; }) || {};
      var awayC = competitors.find(function (c) { return c.homeAway === "away"; }) || {};

      function rec(c) {
        var r = (c.record || []).find(function (x) { return x.type === "total"; }) || (c.record || [])[0];
        return r ? r.summary + "(勝-敗)" : "";
      }
      var html = detailHeaderHtml(game, rec(awayC), rec(homeC));

      if (game.status === "scheduled" || game.status === "postponed") {
        html += nbaPreviewSections(game, s, awayC, homeC);
        html += oddsDetailHtml(game);
        body.innerHTML = html;
        return;
      }

      // quarter line score
      var aLs = awayC.linescores || [];
      var hLs = homeC.linescores || [];
      var n = Math.max(aLs.length, hLs.length);
      if (n > 0) {
        var head = '<tr><th>隊伍</th>';
        for (var i = 0; i < n; i++) head += '<th>' + (i < 4 ? "Q" + (i + 1) : "OT" + (i - 3)) + '</th>';
        head += '<th>總分</th></tr>';
        function qRow(name, ls, total) {
          var row = '<tr><td>' + esc(name) + '</td>';
          for (var i = 0; i < n; i++) {
            row += '<td>' + esc(ls[i] ? ls[i].displayValue : "-") + '</td>';
          }
          row += '<td><b>' + esc(total) + '</b></td></tr>';
          return row;
        }
        html += sectionBlock("逐節比分",
          '<div class="table-wrap"><table class="stat-table">' + head +
          qRow(game.away.name, aLs, scoreText(game.away.score)) +
          qRow(game.home.name, hLs, scoreText(game.home.score)) +
          '</table></div>');
      }

      // player stats
      var teams = (s.boxscore && s.boxscore.players) || [];
      teams.forEach(function (t) {
        var stat = t.statistics && t.statistics[0];
        if (!stat || !stat.athletes) return;
        var names = stat.names || [];
        var cols = ["MIN", "PTS", "REB", "AST", "STL", "BLK", "FG", "3PT", "+/-"];
        var colIdx = cols.map(function (c) { return names.indexOf(c); });
        var zhCols = { MIN: "分鐘", PTS: "得分", REB: "籃板", AST: "助攻", STL: "抄截", BLK: "阻攻", FG: "投籃", "3PT": "三分", "+/-": "+/-" };

        var head = '<tr><th>球員</th>' + cols.map(function (c) { return '<th>' + zhCols[c] + '</th>'; }).join("") + '</tr>';
        var rows = "";
        stat.athletes.forEach(function (a) {
          if (!a.stats || a.stats.length === 0) return;
          var starter = a.starter ? ' <span class="starter-mark">先發</span>' : "";
          rows += '<tr><td>' + esc(a.athlete.displayName) + starter + '</td>' +
            colIdx.map(function (idx) { return '<td>' + esc(idx >= 0 ? a.stats[idx] : "-") + '</td>'; }).join("") + '</tr>';
        });
        if (rows) {
          html += sectionBlock(t.team.displayName + " 球員數據",
            '<div class="table-wrap"><table class="stat-table">' + head + rows + '</table></div>');
        }
      });

      // game leaders
      var leaders = s.leaders || [];
      if (leaders.length) {
        var lRows = "";
        leaders.forEach(function (teamLeaders) {
          (teamLeaders.leaders || []).forEach(function (cat) {
            if (["points", "rebounds", "assists"].indexOf(cat.name) === -1) return;
            var top = cat.leaders && cat.leaders[0];
            if (!top) return;
            var zh = { points: "得分", rebounds: "籃板", assists: "助攻" }[cat.name];
            lRows += '<li><span>' + esc(teamLeaders.team ? teamLeaders.team.abbreviation : "") + " " + zh + ":<b>" +
              esc(top.athlete.displayName) + "</b></span><span>" + esc(top.displayValue) + "</span></li>";
          });
        });
        if (lRows) html += sectionBlock("數據領先者", '<ul class="injury-list">' + lRows + '</ul>');
      }

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

    if (!html) {
      html = sectionBlock("賽前資訊", '<div class="analysis-box"><p>暫無更多賽前資料,開賽後將顯示逐節比分與球員數據。</p></div>');
    }
    return html;
  }

  // ---------- NPB / KBO detail ----------
  function parseTsdbInnings(str) {
    if (!str) return null;
    var blocks = String(str).split(/<br\s*\/?>\s*<br\s*\/?>/i);
    var out = [];
    blocks.forEach(function (b) {
      var m = b.match(/^\s*(.*?)\s+Innings:\s*<br\s*\/?>\s*([\d\s]+?)\s*(?:<br\s*\/?>\s*Hits:\s*(\d+)\s*-\s*Errors:\s*(\d+))?\s*$/i);
      if (m && m[2].trim()) {
        out.push({
          name: m[1].trim(),
          innings: m[2].trim().split(/\s+/).map(Number),
          hits: m[3] !== undefined ? Number(m[3]) : null,
          errors: m[4] !== undefined ? Number(m[4]) : null,
        });
      }
    });
    return out.length >= 2 ? out : null;
  }

  function renderTsdbDetail(game, body) {
    return fetchJson("https://www.thesportsdb.com/api/v1/json/123/lookupevent.php?id=" + game.tsdbId)
      .catch(function () { return null; })
      .then(function (data) {
        var e = (data && data.events && data.events[0]) || game.raw || {};
        var html = detailHeaderHtml(game, null, null);

        var parsed = parseTsdbInnings(e.strResult);
        if (parsed) {
          var awayBlock = parsed.find(function (p) { return p.name === game.away.name; });
          var homeBlock = parsed.find(function (p) { return p.name === game.home.name; });
          if (!awayBlock || !homeBlock) { homeBlock = parsed[0]; awayBlock = parsed[1]; }

          var n = Math.max(awayBlock.innings.length, homeBlock.innings.length);
          var head = '<tr><th>隊伍</th>';
          for (var i = 1; i <= n; i++) head += '<th>' + i + '</th>';
          head += '<th>R</th><th>H</th><th>E</th></tr>';

          function iRow(name, blk, total) {
            var row = '<tr><td>' + esc(name) + '</td>';
            for (var i = 0; i < n; i++) {
              row += '<td>' + (blk.innings[i] !== undefined ? blk.innings[i] : "-") + '</td>';
            }
            var runs = total !== null && total !== undefined ? total : blk.innings.reduce(function (a, b) { return a + b; }, 0);
            row += '<td><b>' + esc(runs) + '</b></td>' +
              '<td>' + esc(blk.hits !== null ? blk.hits : "-") + '</td>' +
              '<td>' + esc(blk.errors !== null ? blk.errors : "-") + '</td></tr>';
            return row;
          }
          html += sectionBlock("逐局比分",
            '<div class="table-wrap"><table class="stat-table">' + head +
            iRow(game.away.name, awayBlock, game.away.score) +
            iRow(game.home.name, homeBlock, game.home.score) +
            '</table></div>');
        } else if (game.status !== "scheduled") {
          html += sectionBlock("逐局比分",
            '<div class="analysis-box"><p>逐局比分尚未提供,通常於比賽結束後更新。</p></div>');
        }

        var metaItems = [];
        if (game.startTime) metaItems.push(["開賽時間(台北)", formatDateTime(game.startTime)]);
        if (e.strVenue) metaItems.push(["球場", e.strVenue]);
        if (e.strCity) metaItems.push(["城市", e.strCity]);
        if (e.intRound && e.intRound !== "0") metaItems.push(["輪次", e.intRound]);
        if (e.strSeason) metaItems.push(["球季", e.strSeason]);
        if (metaItems.length) {
          html += sectionBlock("比賽資訊",
            '<div class="meta-grid">' + metaItems.map(function (m) {
              return '<div class="meta-item"><div class="k">' + esc(m[0]) + '</div><div class="v">' + esc(m[1]) + '</div></div>';
            }).join("") + '</div>');
        }

        if (game.status === "scheduled") {
          html += sectionBlock("賽前資訊",
            '<div class="analysis-box"><p>此聯盟的免費資料來源未提供先發名單、球員數據與賠率;開賽後可在此查看逐局比分。</p></div>');
        } else {
          html += '<div class="detail-note">此聯盟的資料來源未提供球員個人數據。</div>';
        }

        body.innerHTML = html;
      });
  }

  // ---------- modal control ----------
  var DETAIL_RENDERERS = { mlb: renderMlbDetail, nba: renderNbaDetail, npb: renderTsdbDetail, kbo: renderTsdbDetail };

  function loadDetail(game) {
    var body = document.getElementById("modalBody");
    return DETAIL_RENDERERS[game.league](game, body).catch(function (err) {
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

    if (modal.timer) clearInterval(modal.timer);
    if (game.status === "live") {
      modal.timer = setInterval(function () {
        if (!document.hidden && modal.game) loadDetail(modal.game);
      }, 15000);
    }
  }

  function closeDetail() {
    modal.game = null;
    if (modal.timer) { clearInterval(modal.timer); modal.timer = null; }
    var m = document.getElementById("modal");
    m.classList.add("hidden");
    m.setAttribute("aria-hidden", "true");
    document.body.style.overflow = "";
  }

  // ---------- controls ----------
  function loadAndReschedule() {
    return loadAll().then(scheduleNext);
  }

  function setFilter(key) {
    state.filter = key;
    document.querySelectorAll(".tab").forEach(function (t) {
      t.classList.toggle("active", t.dataset.league === key);
    });
    loadAndReschedule();
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
    loadAndReschedule();
  }

  function goToday() {
    state.date = new Date();
    clearGames();
    loadAndReschedule();
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
      loadAndReschedule().then(function () {
        var b = document.getElementById("refreshBtn");
        if (b) b.classList.remove("spinning");
      });
    });
    document.getElementById("autoRefreshToggle").addEventListener("change", function (e) {
      state.autoRefresh = e.target.checked;
      scheduleNext();
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

    // resume immediately when tab becomes visible again
    document.addEventListener("visibilitychange", function () {
      if (!document.hidden && state.autoRefresh && sched.nextAt && Date.now() > sched.nextAt) {
        loadAndReschedule();
      }
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
    loadAndReschedule();
    setInterval(updateStatusText, 1000);
  }

  document.addEventListener("DOMContentLoaded", init);
})();
