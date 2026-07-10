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
  function formatTime(iso) {
    if (!iso) return "";
    var d = new Date(iso);
    if (isNaN(d.getTime())) return "";
    return d.toLocaleTimeString("zh-TW", { hour: "2-digit", minute: "2-digit", hour12: false });
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

  // one range-schedule call covers every team's recent first-inning record
  function fetchFirstInningRates() {
    var end = new Date(); end.setDate(end.getDate() - 1);
    var start = new Date(); start.setDate(start.getDate() - 25);
    var url = "https://statsapi.mlb.com/api/v1/schedule?sportId=1&startDate=" + toISODate(start) +
      "&endDate=" + toISODate(end) + "&hydrate=linescore";
    return fetchJson(url).then(function (data) {
      var byTeam = {}; // teamId -> chronological [{scored, allowed}]
      (data.dates || []).forEach(function (d) {
        (d.games || []).forEach(function (g) {
          if (!(g.status && g.status.abstractGameState === "Final")) return;
          var inn1 = g.linescore && g.linescore.innings && g.linescore.innings[0];
          if (!inn1 || !inn1.away || !inn1.home) return;
          var aRuns = Number(inn1.away.runs) > 0, hRuns = Number(inn1.home.runs) > 0;
          var aId = g.teams.away.team.id, hId = g.teams.home.team.id;
          (byTeam[aId] = byTeam[aId] || []).push({ scored: aRuns, allowed: hRuns });
          (byTeam[hId] = byTeam[hId] || []).push({ scored: hRuns, allowed: aRuns });
        });
      });
      var rates = {};
      Object.keys(byTeam).forEach(function (id) {
        var games = byTeam[id].slice(-15);
        if (games.length < 8) return;
        var off = 0, def = 0;
        games.forEach(function (g) { if (g.scored) off++; if (g.allowed) def++; });
        rates[id] = { n: games.length, off: off, def: def, offRate: off / games.length, defRate: def / games.length };
      });
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
        map[p.id] = (splits && splits[0] && splits[0].stat) || {};
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

  function l10Rate(rec) {
    if (!rec || !rec.lastTen) return null;
    var parts = rec.lastTen.split("-");
    var w = Number(parts[0]), l = Number(parts[1]);
    return (w + l) > 0 ? w / (w + l) : null;
  }

  // same blend the game-detail modal uses: record share + last-10 share,
  // starter-ERA nudge, flat home advantage
  function mlbModelHome(aRec, hRec, aEra, hEra) {
    if (!aRec || !hRec) return null;
    var comps = [];
    if (aRec.pct + hRec.pct > 0) comps.push(hRec.pct / (aRec.pct + hRec.pct));
    var aL10 = l10Rate(aRec), hL10 = l10Rate(hRec);
    if (aL10 !== null && hL10 !== null && aL10 + hL10 > 0) comps.push(hL10 / (aL10 + hL10));
    if (!comps.length) return null;
    var m = comps.reduce(function (x, y) { return x + y; }, 0) / comps.length;
    if (isFinite(aEra) && isFinite(hEra)) m += clampNum((aEra - hEra) * 0.04, -0.06, 0.06);
    m += 0.035;
    return clampNum(m, 0.05, 0.95);
  }

  function collectMlb() {
    var today = toISODate(new Date());
    var season = new Date().getFullYear();
    var schedP = fetchJson("https://statsapi.mlb.com/api/v1/schedule?sportId=1&date=" + today + "&hydrate=probablePitcher,team");
    var espnP = fetchJson("https://site.api.espn.com/apis/site/v2/sports/baseball/mlb/scoreboard?dates=" + today.replace(/-/g, ""))
      .then(buildEspnMlMap).catch(function () { return {}; });

    return Promise.all([schedP, fetchMlbStandings(season), espnP, fetchFirstInningRates()]).then(function (res) {
      var sched = res[0], standings = res[1], mlMap = res[2], fiRates = res[3];
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
      ]).then(function (pres) {
        var seasonStats = pres[0];
        var fiByPitcher = {};
        pitcherIds.forEach(function (id, i) { fiByPitcher[id] = pres[1][i]; });

        var candidates = [];
        games.forEach(function (g) {
          var away = g.teams.away.team, home = g.teams.home.team;
          var aRec = standings[away.id], hRec = standings[home.id];
          var ppA = g.teams.away.probablePitcher, ppH = g.teams.home.probablePitcher;
          var aSt = ppA ? (seasonStats[ppA.id] || {}) : {};
          var hSt = ppH ? (seasonStats[ppH.id] || {}) : {};
          var base = {
            league: "MLB",
            away: away.name, home: home.name,
            start: g.gameDate,
          };

          // -- moneyline value --
          var ml = mlMap[away.name + "|" + home.name];
          var fair = ml ? fairProbs(ml.a.cur, ml.h.cur) : null;
          var modelH = mlbModelHome(aRec, hRec, Number(aSt.era), Number(hSt.era));
          if (fair && modelH !== null) {
            var edgeH = modelH - fair.home, edgeA = (1 - modelH) - fair.away;
            var pickHome = edgeH >= edgeA;
            var edge = pickHome ? edgeH : edgeA;
            var prob = pickHome ? modelH : 1 - modelH;
            var price = pickHome ? ml.h.cur : ml.a.cur;
            var reasons = [];
            if (aRec && hRec) {
              reasons.push("戰績:客 " + aRec.wins + "-" + aRec.losses + "(近十場 " + (aRec.lastTen || "-") +
                "),主 " + hRec.wins + "-" + hRec.losses + "(近十場 " + (hRec.lastTen || "-") + ")。");
            }
            if (ppA && ppH) {
              reasons.push("先發:" + esc(ppA.fullName) + " ERA " + esc(aSt.era || "-") +
                " vs " + esc(ppH.fullName) + " ERA " + esc(hSt.era || "-") + "。");
            }
            reasons.push("模型勝率 <b>" + pctStr(prob) + "</b> vs 市場中性機率 " +
              pctStr(pickHome ? fair.home : fair.away) + ",優勢 <b>" + (edge >= 0 ? "+" : "") + (edge * 100).toFixed(1) + "%</b>。");
            var mv = mlMoveNote(ml, pickHome, away.name, home.name);
            if (mv) reasons.push(mv);
            candidates.push(Object.assign({}, base, {
              type: "ml",
              pick: (pickHome ? home.name + " 主勝" : away.name + " 客勝"),
              price: String(price),
              prob: prob,
              market: pickHome ? fair.home : fair.away,
              edge: edge,
              reasons: reasons,
            }));
          }

          // -- NRFI / YRFI --
          var aFi = fiRates[away.id], hFi = fiRates[home.id];
          if (aFi && hFi) {
            var pA = (aFi.offRate + hFi.defRate) / 2;
            var pH = (hFi.offRate + aFi.defRate) / 2;
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
            nrfi = clampNum(nrfi, 0.05, 0.95);
            var beNr = impliedProb(NRFI_PRICE); // ~52.4%
            var pickNrfi = nrfi >= 0.5;
            var prob2 = pickNrfi ? nrfi : 1 - nrfi;
            reasons2.push("估計 " + (pickNrfi ? "NRFI" : "YRFI") + " 機率 <b>" + pctStr(prob2) +
              "</b>,以 " + NRFI_PRICE + " 水位計損益兩平為 " + pctStr(beNr) +
              ",優勢 <b>" + ((prob2 - beNr) >= 0 ? "+" : "") + ((prob2 - beNr) * 100).toFixed(1) + "%</b>。");
            candidates.push(Object.assign({}, base, {
              type: pickNrfi ? "nrfi" : "yrfi",
              pick: pickNrfi ? "NRFI 首局雙方皆不得分" : "YRFI 首局至少一方得分",
              price: NRFI_PRICE + "(參考)",
              prob: prob2,
              market: beNr,
              edge: prob2 - beNr,
              reasons: reasons2,
            }));
          }
        });
        return candidates;
      });
    });
  }

  // ---------- NBA data (edge = ESPN predictor vs. market) ----------
  function collectNba() {
    var ymd = toISODate(new Date()).replace(/-/g, "");
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

  // ---------- render ----------
  var TYPE_LABEL = { ml: "勝負盤", nrfi: "首局 NRFI", yrfi: "首局 YRFI" };

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
            '<span class="pick-time">' + esc(formatTime(c.start)) + ' 開賽</span>' +
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
    var fi = candidates.filter(function (c) { return c.type === "nrfi" || c.type === "yrfi"; }).sort(byEdge);
    var ml = candidates.filter(function (c) { return c.type === "ml"; }).sort(byEdge);

    if (!fi.length && !ml.length) {
      el.innerHTML = '<div class="empty-state">今天沒有可分析的未開賽場次(賽事已全部開打、休兵日,或賠率尚未開出)。<br>盤口通常於美東早上陸續開出,可稍後再回來看。</div>';
      return;
    }
    el.innerHTML =
      '<div class="picks-intro analysis-box"><p>' +
      '共掃描 <b>' + candidates.length + '</b> 個候選,分為「首局 NRFI/YRFI」與「勝負盤」兩區,' +
      '各依「模型機率 − 市場損益兩平機率」的優勢由高至低取前 ' + TOP_N + ' 名。' +
      '優勢代表理論期望值,不代表必中;半凱利為對應的建議資金比例上限。</p></div>' +
      sectionHtml("⚾ 首局 NRFI / YRFI", fi.slice(0, TOP_N), fi.length) +
      sectionHtml("🏆 勝負盤(MLB / NBA)", ml.slice(0, TOP_N), ml.length);
  }

  function run() {
    var el = document.getElementById("picksContent");
    el.innerHTML = '<div class="detail-loading"><div class="spinner"></div>正在抓取賽程、賠率與數據,計算今日最值得買的五注…</div>';
    document.getElementById("updatedAt").textContent = "計算中…";
    Promise.all([
      collectMlb().catch(function () { return []; }),
      collectNba(),
    ]).then(function (res) {
      render(res[0].concat(res[1]));
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
