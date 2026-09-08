/* 人狼遊戲 Phase 2：大廳 / 玩家 / 觀戰三模式 */
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

  var ROLE_DISPLAY = {
    villager: '村民 🟢',
    seer: '占い師 🔮',
    medium: '靈能者 👁️',
    guard: '獵人 🛡️',
    mason: '共有者 🤝',
    werewolf: '人狼 🔴',
    madman: '狂人 🤡',
  };

  var ROLE_DESCRIPTION = {
    villager: '無特殊能力，靠推理與投票找出人狼',
    seer: '每夜選一名存活玩家查驗，結果為「村人」或「人狼」',
    medium: '得知白天被投票出局者的身分',
    guard: '每夜守護一人免於人狼襲擊，第一天不可守護',
    mason: '雙人組，互相知道對方身分',
    werewolf: '夜間合謀，全體共同選擇一人殺害',
    madman: '無特殊能力，人狼勝則狂人勝',
  };

  var TOKEN_KEY = 'ww-token';

  var ws = null;
  var retryMs = 1000;
  var left = false;
  var gmView = false;

  var state = {
    mode: 'lobby',        // 'lobby' | 'player' | 'spectator'
    playerId: null,
    token: null,
    selectedTarget: null,
    readySent: false,     // 本機追蹤準備投票（snapshot 無 voteReady）
    lastPhase: null,
  };
  try {
    state.token = localStorage.getItem(TOKEN_KEY);
  } catch (e) { /* ignore */ }

  var boardEl = document.getElementById('board');
  var playersEl = document.getElementById('players');
  var meEl = document.getElementById('me');
  var controlsBody = document.getElementById('controls-body');
  var errorEl = document.getElementById('error');
  var dayEl = document.getElementById('day-label');
  var phaseEl = document.getElementById('phase-label');
  var connEl = document.getElementById('conn-label');
  var overlayEl = document.getElementById('disconnect-overlay');
  var overlayText = document.getElementById('disconnect-text');
  var lobbyOverlay = document.getElementById('lobby-overlay');
  var lobbySeats = document.getElementById('lobby-seats');
  var lobbyName = document.getElementById('lobby-name');
  var startBtn = document.getElementById('start-btn');
  var gmBtn = document.getElementById('gm-toggle');
  var leaveBtn = document.getElementById('leave-btn');

  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function fmtMB1(n) {
    var v = Number(n);
    if (!isFinite(v)) return '0.0';
    return (Math.round(v * 10) / 10).toFixed(1);
  }

  function setConn(text) {
    connEl.textContent = text;
  }

  function showError(text) {
    errorEl.textContent = text;
    errorEl.hidden = false;
    setTimeout(function () {
      errorEl.hidden = true;
    }, 4000);
  }

  function send(obj) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(obj));
    }
  }

  function connect() {
    if (left) return;
    ws = new WebSocket('ws://' + location.host);
    ws.onopen = function () {
      setConn('已連線');
      overlayEl.hidden = true;
      retryMs = 1000;
      if (state.token) {
        send({ type: 'RECONNECT', token: state.token });
      } else {
        send({ type: 'REQUEST_SNAPSHOT' });
      }
    };
    ws.onmessage = function (ev) {
      var msg;
      try {
        msg = JSON.parse(ev.data);
      } catch (e) {
        return;
      }
      if (msg.type === 'LOBBY') {
        renderLobby(msg.lobby);
      } else if (msg.type === 'JOINED') {
        state.playerId = msg.playerId;
        state.token = msg.token;
        state.mode = 'player';
        state.selectedTarget = null;
        try {
          localStorage.setItem(TOKEN_KEY, msg.token);
        } catch (e) { /* ignore */ }
        send({ type: 'REQUEST_SNAPSHOT' });
      } else if (msg.type === 'JOIN_REJECTED' || msg.type === 'ACTION_REJECTED') {
        showError(msg.reason || '操作被拒絕');
      } else if (msg.type === 'SNAPSHOT') {
        if (msg.snapshot && msg.snapshot.you) {
          state.mode = 'player';
          renderPlayer(msg.snapshot);
        } else {
          if (state.mode !== 'player') state.mode = 'spectator';
          renderSpectator(msg.snapshot, msg.gmView);
        }
      } else if (msg.type === 'ERROR') {
        // 後端延遲啟動失敗（例如模型未就緒）：顯示錯誤，不再空白卡死
        phaseEl.textContent = '啟動失敗';
        showError(msg.message || '啟動失敗');
      } else if (msg.type === 'MODEL_STATUS') {
        // 引擎準備進度（模型 / llama-server 下載中）：顯示在狀態列，避免空白等待
        if (msg.state === 'downloading') {
          var prog = msg.total > 0
            ? Math.floor((msg.downloaded / msg.total) * 100) + '%（' + fmtMB1(msg.downloaded / 1048576) + ' / ' + fmtMB1(msg.total / 1048576) + ' MB）'
            : (msg.downloaded ? fmtMB1(msg.downloaded / 1048576) : '0.0') + ' MB';
          phaseEl.textContent = (msg.stage === 'llama-server' ? '下載執行環境…' : '模型下載中…') + prog;
        } else if (msg.state === 'starting') {
          phaseEl.textContent = '啟動執行環境…' + (msg.info ? '（' + msg.info + '）' : '');
        } else if (msg.state === 'ready') {
          phaseEl.textContent = msg.stage === 'llama-server' ? '執行環境就緒' : '模型就緒';
        } else if (msg.state === 'error') {
          phaseEl.textContent = '啟動失敗';
          showError('啟動失敗：' + (msg.error || '未知錯誤'));
        }
      } else if (msg.type === 'PING') {
        send({ type: 'PONG' });
      } else if (msg.type === 'SHUTDOWN') {
        overlayText.textContent = '伺服器已關閉';
        overlayEl.hidden = false;
        try {
          ws.close();
        } catch (e) { /* ignore */ }
      }
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

  // ---------- 大廳 ----------

  function renderLobby(lobby) {
    state.mode = state.playerId !== null ? 'player' : 'lobby';
    phaseEl.textContent = PHASE_LABELS[lobby.phase] || lobby.phase;
    lobbyOverlay.hidden = false;
    var html = '';
    for (var i = 0; i < lobby.seats.length; i++) {
      var seat = lobby.seats[i];
      if (seat.controlledBy === 'empty') {
        html += '<button type="button" class="seat empty" data-seat="' + seat.playerId + '">P' + seat.playerId + '<br>空位</button>';
      } else if (seat.controlledBy === 'ai') {
        html += '<div class="seat ai">P' + seat.playerId + '<br>AI</div>';
      } else {
        html += '<div class="seat human">P' + seat.playerId + ' ' + esc(seat.name) + '<br>真人</div>';
      }
    }
    lobbySeats.innerHTML = html;
    var btns = lobbySeats.querySelectorAll('button.seat');
    for (var b = 0; b < btns.length; b++) {
      btns[b].addEventListener('click', function () {
        var pid = parseInt(this.getAttribute('data-seat'), 10);
        var name = lobbyName.value.trim() || undefined;
        send({ type: 'JOIN', playerId: pid, name: name });
      });
    }
    // 已選座的真人可按開始
    startBtn.hidden = state.mode !== 'player';
  }

  function hideLobby() {
    lobbyOverlay.hidden = true;
  }

  startBtn.addEventListener('click', function () {
    send({ type: 'START_GAME' });
  });

  // ---------- 白板 / 玩家卡片共用 ----------

  function boardHtml(snapshot) {
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
    return html || '<div class="msg">等待遊戲開始…</div>';
  }

  // 玩家卡片：只顯示 P{id} name，不顯示 controlledBy / AI 標記
  function playersHtml(snapshot, selectable) {
    var alive = {};
    var plist = snapshot.alivePlayers || [];
    for (var a = 0; a < plist.length; a++) alive[plist[a].id] = true;
    var html = '<h2>玩家</h2>';
    var gmPlayers = snapshot.players || null;
    if (gmPlayers) {
      for (var g = 0; g < gmPlayers.length; g++) {
        var gp = gmPlayers[g];
        var cls = gp.alive ? 'alive' : 'dead';
        html += '<div class="' + cls + '">P' + gp.id + ' ' + esc(gp.name) + '（' + esc(gp.role) + '）</div>';
      }
      return html;
    }
    for (var p = 0; p < plist.length; p++) {
      var sel = selectable && state.selectedTarget === plist[p].id ? ' selected' : '';
      var click = selectable ? ' data-target="' + plist[p].id + '"' : '';
      html += '<div class="alive' + (selectable ? ' selectable' : '') + sel + '"' + click + '>P' + plist[p].id + ' ' + esc(plist[p].name) + '</div>';
    }
    var deaths = snapshot.deadPlayers || [];
    for (var q = 0; q < deaths.length; q++) {
      html += '<div class="dead">P' + deaths[q].id + ' ' + esc(deaths[q].name) + '（' + esc(deaths[q].cause) + '）</div>';
    }
    return html;
  }

  function bindCardSelect() {
    var cards = playersEl.querySelectorAll('[data-target]');
    for (var i = 0; i < cards.length; i++) {
      cards[i].addEventListener('click', function () {
        state.selectedTarget = parseInt(this.getAttribute('data-target'), 10);
        var all = playersEl.querySelectorAll('[data-target]');
        for (var j = 0; j < all.length; j++) {
          all[j].classList.toggle('selected', parseInt(all[j].getAttribute('data-target'), 10) === state.selectedTarget);
        }
        var numInput = document.getElementById('target-input');
        if (numInput) numInput.value = String(state.selectedTarget);
      });
    }
  }

  function targetInputHtml() {
    return '<div>P 編號備援：<input id="target-input" type="number" min="1" placeholder="P編號">'
      + '<button id="target-apply" type="button">選定</button></div>';
  }

  function bindTargetInput() {
    var apply = document.getElementById('target-apply');
    if (!apply) return;
    apply.addEventListener('click', function () {
      var v = parseInt(document.getElementById('target-input').value, 10);
      if (v > 0) {
        state.selectedTarget = v;
        bindCardRefresh();
      }
    });
  }

  function bindCardRefresh() {
    var all = playersEl.querySelectorAll('[data-target]');
    for (var j = 0; j < all.length; j++) {
      all[j].classList.toggle('selected', parseInt(all[j].getAttribute('data-target'), 10) === state.selectedTarget);
    }
  }

  // ---------- 觀戰 ----------

  function renderSpectator(snapshot, isGm) {
    hideLobby();
    gmBtn.hidden = false;
    meEl.hidden = true;
    dayEl.textContent = '第 ' + snapshot.day + ' 天';
    phaseEl.textContent = PHASE_LABELS[snapshot.phase] || snapshot.phase;
    boardEl.innerHTML = boardHtml(snapshot);
    boardEl.scrollTop = boardEl.scrollHeight;
    playersEl.innerHTML = playersHtml(snapshot, false);
    controlsBody.innerHTML = '<div class="msg">觀戰中…（真人請在大廳選座加入）</div>';
  }

  // ---------- 玩家 ----------

  function renderPlayer(snapshot) {
    hideLobby();
    gmBtn.hidden = true;
    if (snapshot.phase !== state.lastPhase) {
      state.readySent = false;
      state.selectedTarget = null;
      state.lastPhase = snapshot.phase;
    }
    dayEl.textContent = '第 ' + snapshot.day + ' 天';
    phaseEl.textContent = PHASE_LABELS[snapshot.phase] || snapshot.phase;
    boardEl.innerHTML = boardHtml(snapshot);
    boardEl.scrollTop = boardEl.scrollHeight;

    var needSelect = snapshot.phase === 'DAY_VOTING_COLLECTING'
      || (snapshot.phase === 'NIGHT_COLLECTING' && snapshot.you.canAct);
    playersEl.innerHTML = playersHtml(snapshot, needSelect);
    if (needSelect) bindCardSelect();

    renderMe(snapshot);
    renderControls(snapshot);
  }

  function renderMe(snapshot) {
    meEl.hidden = false;
    var you = snapshot.you;
    var html = '<h2>我的身分：P' + state.playerId + '</h2>';
    html += '<div>' + esc(ROLE_DISPLAY[you.role] || you.role) + '</div>';
    html += '<div class="desc">' + esc(ROLE_DESCRIPTION[you.role] || '') + '</div>';
    if (you.seerChecks && you.seerChecks.length > 0) {
      html += '<div>查驗：' + you.seerChecks.map(function (c) {
        return 'P' + c.targetId + '=' + (c.result === 'werewolf' ? '人狼' : '村人');
      }).join('、') + '</div>';
    }
    if (you.guardProtects && you.guardProtects.length > 0) {
      html += '<div>守護：' + you.guardProtects.map(function (g) {
        return 'P' + g.targetId;
      }).join('、') + '</div>';
    }
    if (you.mediumResults && you.mediumResults.length > 0) {
      html += '<div>靈能：' + you.mediumResults.map(function (m) {
        return 'P' + m.targetId + '=' + (m.team === 'werewolf' ? '人狼' : '村人');
      }).join('、') + '</div>';
    }
    if (you.masonPartnerId) {
      html += '<div>共有者夥伴：P' + you.masonPartnerId + '</div>';
    }
    if (you.wolfAllyIds && you.wolfAllyIds.length > 0) {
      html += '<div>狼同伴：' + you.wolfAllyIds.map(function (id) { return 'P' + id; }).join('、') + '</div>';
    }
    meEl.innerHTML = html;
  }

  function renderControls(snapshot) {
    var you = snapshot.you;
    var html = '';
    var alive = {};
    for (var i = 0; i < (snapshot.alivePlayers || []).length; i++) {
      alive[snapshot.alivePlayers[i].id] = true;
    }
    var iAmAlive = state.playerId !== null && !!alive[state.playerId];

    if (!iAmAlive) {
      controlsBody.innerHTML = '<div class="msg">你已出局，觀戰中…</div>';
      return;
    }

    if (snapshot.phase === 'NIGHT_COLLECTING') {
      if (!you.canAct) {
        html = '<div class="msg">等待其他玩家行動…</div>';
      } else if (you.role === 'werewolf') {
        html = '<h3>狼人會議</h3>';
        if (you.wolfMeeting && you.wolfMeeting.length > 0) {
          html += '<div>目前提交：' + you.wolfMeeting.map(function (m) {
            return 'P' + m.wolfId + '→P' + m.targetId;
          }).join('、') + '</div>';
        } else {
          html += '<div>尚無提交</div>';
        }
        html += '<div>選擇襲擊目標（點卡片或輸入編號）：</div>' + targetInputHtml();
        html += '<div><button id="night-confirm" type="button">確認</button></div>';
      } else if (you.role === 'seer') {
        html = '<div>選擇查驗目標：</div>' + targetInputHtml();
        html += '<div><button id="night-confirm" type="button">確認</button></div>';
      } else if (you.role === 'guard') {
        if (snapshot.day === 1) {
          html = '<div class="msg">第一晚不可守護</div>';
        } else {
          html = '<div>選擇守護目標：</div>' + targetInputHtml();
          html += '<div><button id="night-confirm" type="button">確認</button></div>';
        }
      } else {
        html = '<div class="msg">無夜間行動</div>';
      }
    } else if (snapshot.phase === 'DAY_DISCUSSION_OPEN') {
      html = '<div><input id="speak-input" type="text" placeholder="發言…">'
        + '<button id="speak-btn" type="button">發言</button></div>';
      html += '<div><button id="skip-btn" type="button">跳過發言</button></div>';
      html += state.readySent
        ? '<div><button id="unready-btn" type="button">取消準備</button></div>'
        : '<div><button id="ready-btn" type="button">準備投票</button></div>';
    } else if (snapshot.phase === 'DAY_DISCUSSION_CLOSING') {
      html = state.readySent
        ? '<div><button id="unready-btn" type="button">取消準備</button></div>'
        : '<div><button id="ready-btn" type="button">準備投票</button></div>';
    } else if (snapshot.phase === 'DAY_VOTING_COLLECTING') {
      if (!you.canAct) {
        html = '<div class="msg">等待投票…（已投票或無需行動）</div>';
      } else {
        html = '<div>選擇投票目標：</div>' + targetInputHtml();
        html += '<div><button id="vote-confirm" type="button">確認投票</button></div>';
      }
    } else if (snapshot.phase === 'GAME_OVER_FINAL') {
      var winner = snapshot.winner === 'werewolf' ? '人狼陣營獲勝' : '村人陣營獲勝';
      html = '<div class="msg result">遊戲結束：' + esc(winner) + '</div>';
    } else {
      html = '<div class="msg">等待中…</div>';
    }

    controlsBody.innerHTML = html;

    var speakBtn = document.getElementById('speak-btn');
    if (speakBtn) {
      speakBtn.addEventListener('click', function () {
        var text = document.getElementById('speak-input').value.trim();
        if (text) send({ type: 'HUMAN_SPEAK', text: text });
      });
    }
    var skipBtn = document.getElementById('skip-btn');
    if (skipBtn) {
      skipBtn.addEventListener('click', function () {
        send({ type: 'HUMAN_SKIP' });
      });
    }
    var readyBtn = document.getElementById('ready-btn');
    if (readyBtn) {
      readyBtn.addEventListener('click', function () {
        state.readySent = true;
        send({ type: 'HUMAN_READY_VOTE' });
      });
    }
    var unreadyBtn = document.getElementById('unready-btn');
    if (unreadyBtn) {
      unreadyBtn.addEventListener('click', function () {
        state.readySent = false;
        send({ type: 'HUMAN_UNREADY_VOTE' });
      });
    }
    bindTargetInput();
    var nightConfirm = document.getElementById('night-confirm');
    if (nightConfirm) {
      nightConfirm.addEventListener('click', function () {
        if (state.selectedTarget) send({ type: 'HUMAN_NIGHT_ACTION', targetId: state.selectedTarget });
        else showError('請先選擇目標');
      });
    }
    var voteConfirm = document.getElementById('vote-confirm');
    if (voteConfirm) {
      voteConfirm.addEventListener('click', function () {
        if (state.selectedTarget) send({ type: 'HUMAN_VOTE', targetId: state.selectedTarget });
        else showError('請先選擇目標');
      });
    }
  }

  gmBtn.addEventListener('click', function () {
    gmView = !gmView;
    gmBtn.textContent = 'GM 檢視：' + (gmView ? '開' : '關');
    send({ type: 'SET_GM_VIEW', enabled: gmView });
  });

  leaveBtn.addEventListener('click', function () {
    left = true;
    send({ type: 'LEAVE' });
    try {
      if (ws) ws.close();
    } catch (e) { /* ignore */ }
    try {
      localStorage.removeItem(TOKEN_KEY);
    } catch (e) { /* ignore */ }
    overlayText.textContent = '已離開，可關閉此分頁';
    overlayEl.hidden = false;
    setConn('已離開');
  });

  connect();
})();
