/* 人狼遊戲 Phase 1 觀戰邏輯 */
(function () {
  'use strict';

  var PHASE_LABELS = {
    SETUP_WAITING_JOIN: '等待玩家加入',
    SETUP_READY: '準備開始',
    NIGHT_COLLECTING: '夜晚（行動中）',
    NIGHT_RESOLVING: '夜晚結算',
    DAY_DISCUSSION_OPEN: '白天討論',
    DAY_DISCUSSION_CLOSING: '討論收尾',
    DAY_VOTING_COLLECTING: '投票中',
    DAY_VOTING_RESOLVING: '投票結算',
    DAY_RESULT_ANNOUNCING: '公布結果',
    GAME_OVER_FINAL: '遊戲結束',
  };

  var ws = null;
  var retryMs = 1000;
  var gmView = false;
  var left = false;

  var boardEl = document.getElementById('board');
  var playersEl = document.getElementById('players');
  var dayEl = document.getElementById('day-label');
  var phaseEl = document.getElementById('phase-label');
  var connEl = document.getElementById('conn-label');
  var overlayEl = document.getElementById('disconnect-overlay');
  var overlayText = document.getElementById('disconnect-text');
  var gmBtn = document.getElementById('gm-toggle');
  var leaveBtn = document.getElementById('leave-btn');

  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function setConn(text) {
    connEl.textContent = text;
  }

  function connect() {
    if (left) return;
    ws = new WebSocket('ws://' + location.host);
    ws.onopen = function () {
      setConn('已連線');
      overlayEl.hidden = true;
      retryMs = 1000;
    };
    ws.onmessage = function (ev) {
      var msg;
      try {
        msg = JSON.parse(ev.data);
      } catch (e) {
        return;
      }
      if (msg.type === 'SNAPSHOT') {
        render(msg.snapshot, msg.gmView);
      } else if (msg.type === 'PING') {
        ws.send(JSON.stringify({ type: 'PONG' }));
      } else if (msg.type === 'SHUTDOWN') {
        overlayText.textContent = '伺服器已關閉';
        overlayEl.hidden = false;
        try {
          ws.close();
        } catch (e) { /* ignore */ }
      }
      // MODEL_STATUS：主頁不處理
    };
    ws.onclose = function () {
      if (left) return;
      setConn('斷線');
      overlayText.textContent = '與伺服器斷線，重新連線中…';
      overlayEl.hidden = false;
      setTimeout(connect, retryMs);
      retryMs = Math.min(retryMs * 2, 30000);
    };
  }

  function render(snapshot, isGm) {
    dayEl.textContent = '第 ' + snapshot.day + ' 天';
    phaseEl.textContent = PHASE_LABELS[snapshot.phase] || snapshot.phase;

    var html = '';
    if (snapshot.nightResult) {
      html += '<div class="msg night">' + esc(snapshot.nightResult) + '</div>';
    }
    var deaths = snapshot.deadPlayers || [];
    for (var i = 0; i < deaths.length; i++) {
      var d = deaths[i];
      if (d.day === snapshot.day) {
        html += '<div class="msg death">P' + d.id + '（' + esc(d.name) + '）出局（' + esc(d.cause) + '，第 ' + d.day + ' 天）</div>';
      }
    }
    var log = snapshot.discussionLog || [];
    for (var j = 0; j < log.length; j++) {
      html += '<div class="msg">P' + log[j].playerId + '：' + esc(log[j].text) + '</div>';
    }
    var votes = snapshot.votes || [];
    if (votes.length > 0) {
      var tally = {};
      for (var k = 0; k < votes.length; k++) {
        var t = votes[k].targetId;
        tally[t] = (tally[t] || 0) + 1;
      }
      var parts = Object.keys(tally).map(function (id) {
        return 'P' + id + ': ' + tally[id] + ' 票';
      });
      html += '<div class="msg vote">投票：' + esc(parts.join('、')) + '</div>';
    }
    if (snapshot.gameOver) {
      var winner = snapshot.winner === 'werewolf' ? '人狼陣營獲勝' : '村人陣營獲勝';
      html += '<div class="msg result">遊戲結束：' + esc(winner) + '</div>';
    }
    boardEl.innerHTML = html || '<div class="msg">等待遊戲開始…</div>';
    boardEl.scrollTop = boardEl.scrollHeight;

    var alive = {};
    var plist = snapshot.alivePlayers || [];
    for (var a = 0; a < plist.length; a++) alive[plist[a].id] = true;
    var ph = '<h2>玩家</h2>';
    var gmPlayers = snapshot.players || null; // GM 檢視時 snapshot 為 GMSnapshot（含 players）
    if (isGm && gmPlayers) {
      for (var g = 0; g < gmPlayers.length; g++) {
        var gp = gmPlayers[g];
        var cls = gp.alive ? 'alive' : 'dead';
        ph += '<div class="' + cls + '">P' + gp.id + ' ' + esc(gp.name) + '（' + esc(gp.role) + '）</div>';
      }
    } else {
      for (var p = 0; p < plist.length; p++) {
        ph += '<div class="alive">P' + plist[p].id + ' ' + esc(plist[p].name) + '</div>';
      }
      for (var q = 0; q < deaths.length; q++) {
        ph += '<div class="dead">P' + deaths[q].id + ' ' + esc(deaths[q].name) + '（' + esc(deaths[q].cause) + '）</div>';
      }
    }
    playersEl.innerHTML = ph;
  }

  gmBtn.addEventListener('click', function () {
    gmView = !gmView;
    gmBtn.textContent = 'GM 檢視：' + (gmView ? '開' : '關');
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'SET_GM_VIEW', enabled: gmView }));
    }
  });

  leaveBtn.addEventListener('click', function () {
    left = true;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'LEAVE' }));
      try {
        ws.close();
      } catch (e) { /* ignore */ }
    }
    overlayText.textContent = '已離開，可關閉此分頁';
    overlayEl.hidden = false;
    setConn('已離開');
  });

  connect();
})();
