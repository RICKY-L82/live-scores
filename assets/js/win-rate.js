(function () {
  "use strict";

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

  function esc(s) {
    if (s === null || s === undefined) return "";
    return String(s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }
  function formatTime(iso) {
    if (!iso) return "";
    var d = new Date(iso);
    if (isNaN(d.getTime())) return "";
    return d.toLocaleString("zh-TW", {
      timeZone: "Asia/Taipei", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", hour12: false,
    });
  }
  function fetchJson(url) {
    var ctrl = typeof AbortController !== "undefined" ? new AbortController() : null;
    var timer = ctrl ? setTimeout(function () { ctrl.abort(); }, 20000) : null;
    return fetch(url, ctrl ? { signal: ctrl.signal } : undefined)
      .then(function (res) {
        if (!res.ok) throw new Error("HTTP " + res.status);
        return res.json();
      })
      .finally(function () { if (timer) clearTimeout(timer); });
  }

  // "12-7 (63%)"; null when the sample's too thin to be meaningful
  function winRateStr(bucket) {
    if (!bucket) return null;
    var w = bucket.w || 0, l = bucket.l || 0;
    if (w + l < 3) return null;
    return w + "-" + l + " (" + Math.round((w / (w + l)) * 100) + "%)";
  }

  // Taiwan-date N days from today — matches the date scripts/record-picks.js
  // files each day's snapshot under
  function taipeiDateOffset(days) {
    var d = new Date(Date.now() + days * 86400000);
    return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Taipei" }).format(d);
  }

  var RESULT_LABEL = {
    win: '<span class="pos">✅ 中</span>',
    loss: '<span class="neg">❌ 摃龜</span>',
    push: "➖ 走盤",
    void: "🚫 作廢(延賽等)",
  };
  function resultLabel(result) {
    return RESULT_LABEL[result] || "⏳ 尚未結算";
  }

  function yesterdayHtml(hist, dateStr) {
    if (!hist || !hist.sections) {
      return '<div class="empty-state">' + esc(dateStr) + ' 沒有記錄到任何候選(可能排程尚未執行,或當天各區塊都沒有機率 ≥50% 的候選)。</div>';
    }
    var rows = [];
    Object.keys(SECTION_META).forEach(function (key) {
      (hist.sections[key] || []).forEach(function (p) {
        rows.push(
          "<tr><td>" + SECTION_META[key] + "</td>" +
          "<td>" + esc(p.away) + " @ " + esc(p.home) + "</td>" +
          "<td>" + esc(p.pick) + "</td>" +
          "<td>" + (p.prob * 100).toFixed(1) + "%</td>" +
          "<td>" + resultLabel(p.result) + "</td></tr>"
        );
      });
    });
    if (!rows.length) {
      return '<div class="empty-state">' + esc(dateStr) + ' 沒有記錄到任何候選(可能排程尚未執行,或當天各區塊都沒有機率 ≥50% 的候選)。</div>';
    }
    return '<div class="table-wrap">' +
      '<table class="stat-table"><thead><tr><th>區塊</th><th>對戰</th><th>推薦</th><th>模型機率</th><th>結果</th></tr></thead>' +
      '<tbody>' + rows.join("") + '</tbody></table></div>';
  }

  function render(stats, yesterdayHist, yesterdayDate) {
    var el = document.getElementById("winRateContent");
    var rows = Object.keys(SECTION_META).map(function (key) {
      var s = stats && stats.sections && stats.sections[key];
      var day = winRateStr(s && s.day) || "資料累積中";
      var week = winRateStr(s && s.week) || "資料累積中";
      var month = winRateStr(s && s.month) || "資料累積中";
      return "<tr><td>" + SECTION_META[key] + "</td><td>" + day + "</td><td>" + week + "</td><td>" + month + "</td></tr>";
    }).join("");

    el.innerHTML =
      '<details class="picks-league-section" open>' +
      '<summary class="picks-league-title">📋 昨日戰績(' + esc(yesterdayDate) + ')</summary>' +
      '<div class="picks-league-body">' + yesterdayHtml(yesterdayHist, yesterdayDate) + '</div>' +
      '</details>' +
      '<div class="picks-intro analysis-box"><p>' +
      '每列是「今日推薦 TOP 5」的一個區塊;昨日/本週/本月欄位是該區塊記錄的 TOP3 候選(排除模型機率 &lt;50%)已結算賽事的實際勝率,格式為「勝-負 (勝率)」。' +
      '昨日欄位跟上方「昨日戰績」是同一天;本週/本月 = 往前推 7 天／30 天內已結算的加總。push/延賽不計入分母。樣本數少於 3 注時顯示「資料累積中」,避免用太小的樣本誤導。' +
      '</p></div>' +
      '<div class="table-wrap">' +
      '<table class="stat-table"><thead><tr><th>區塊</th><th>昨日</th><th>本週</th><th>本月</th></tr></thead>' +
      '<tbody>' + rows + '</tbody></table></div>';

    document.getElementById("updatedAt").textContent =
      stats && stats.updated ? "資料更新於 " + formatTime(stats.updated) : "尚無歷史紀錄";
  }

  function run() {
    var el = document.getElementById("winRateContent");
    el.innerHTML = '<div class="detail-loading"><div class="spinner"></div>正在載入歷史勝率資料…</div>';
    document.getElementById("updatedAt").textContent = "載入中…";
    var yesterdayDate = taipeiDateOffset(-1);
    Promise.all([
      fetchJson("data/picks-stats.json?t=" + Date.now()),
      fetchJson("data/picks-history/" + yesterdayDate + ".json?t=" + Date.now()).catch(function () { return null; }),
    ]).then(function (res) {
      render(res[0], res[1], yesterdayDate);
    }).catch(function (err) {
      el.innerHTML = '<div class="error-state">載入失敗:' + esc(err.message || err) + '</div>';
      document.getElementById("updatedAt").textContent = "失敗";
    });
  }

  document.addEventListener("DOMContentLoaded", function () {
    document.getElementById("refreshBtn").addEventListener("click", run);
    run();
  });
})();
