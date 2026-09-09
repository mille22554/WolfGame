/* 人狼遊戲 Phase 2：大廳 / 玩家 / 觀戰三模式 */
(function () {
  'use strict';

  var PHASE_LABELS = {
    SETUP_WAITING_JOIN: '等待玩家加入',
    SETUP_READY: '準備開始',
    NIGHT_COLLECTING: '夜晚（行動中）',
    NIGHT_RESOLVING: '夜晚結算',
    DAY_DISCUSSION_OPEN: '白天討論',
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
  var NAME_KEY = 'ww-name';

  var ws = null;
  var retryMs = 1000;
  var left = false;
  var gmView = false;

  var state = {
    mode: 'lobby',        // 'lobby' | 'player' | 'spectator'
    playerId: null,
    token: null,
    clientId: null,       // 等候大廳契約：hostClientId 比對用（JOINED / LOBBY 攜帶時記下）
    selectedTarget: null,
    readySent: false,     // 本機追蹤準備投票（snapshot 無 voteReady）
    lastPhase: null,
    lobby: null,          // 最近一次 LOBBY snapshot（等候大廳三區渲染用）
    engine: null,         // 最近一次 engineStatus（lobby.engineStatus 或 MODEL_STATUS 轉換）
    chatLog: [],          // 大廳聊天 [{ from, text, ts, mine }]
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
  var startBtn = document.getElementById('start-btn');
  var lobbyError = document.getElementById('lobby-error');
  var lobbyCount = document.getElementById('lobby-count');
  var lobbySpecCount = document.getElementById('lobby-spec-count');
  var lobbySpectators = document.getElementById('lobby-spectators');
  var mynameInput = document.getElementById('myname-input');
  var mynameBtn = document.getElementById('myname-btn');
  var nameMask = document.getElementById('name-mask');
  var nameMaskInput = document.getElementById('name-mask-input');
  var nameMaskBtn = document.getElementById('name-mask-btn');
  var nameMaskError = document.getElementById('name-mask-error');
  var spectateBtn = document.getElementById('spectate-btn');
  var lobbyWatchHint = document.getElementById('lobby-watch-hint');
  var chatLog = document.getElementById('lobby-chat-log');
  var chatInput = document.getElementById('lobby-chat-input');
  var chatSend = document.getElementById('lobby-chat-send');
  var chatCount = document.getElementById('lobby-chat-count');
  var playerCountSel = document.getElementById('lobby-player-count');
  var randomCheck = document.getElementById('lobby-random');
  var startHint = document.getElementById('lobby-start-hint');
  var hostControls = document.getElementById('lobby-host-controls');
  var guestNote = document.getElementById('lobby-guest-note');
  var engineDot = document.getElementById('lobby-engine-dot');
  var engineText = document.getElementById('lobby-engine-text');
  var gmBtn = document.getElementById('gm-toggle');
  var leaveBtn = document.getElementById('leave-btn');
  var lobbyExitBtn = document.getElementById('lobby-exit-btn');
  var lobbyErrorTimer = null;
  var lobbyExitNav = null; // LEAVE_LOBBY 確認後的跳轉（等確認或超時才走，避免座位來不及釋放）
  var lobbyExiting = false;
  var suppressCountEvent = false;
  var suppressRandomEvent = false;

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

  function showLobbyError(text) {
    if (!lobbyError) {
      showError(text);
      return;
    }
    lobbyError.textContent = text;
    lobbyError.hidden = false;
    if (lobbyErrorTimer) clearTimeout(lobbyErrorTimer);
    lobbyErrorTimer = setTimeout(function () {
      lobbyError.hidden = true;
    }, 4000);
    // 取名遮罩可見時同步顯示（擋住大廳，錯誤也要看得到）
    if (nameMask && !nameMask.hidden && nameMaskError) {
      nameMaskError.textContent = text;
      nameMaskError.hidden = false;
    }
  }

  function rememberClientId(msg) {
    // 新契約的 JOINED / LOBBY 可能攜帶自身 clientId，欄位名容錯多收幾種
    var cand = (msg && (msg.clientId || msg.clientID || msg.cid || msg.selfId))
      || (msg && msg.lobby && (msg.lobby.clientId || msg.lobby.selfId || msg.lobby.myClientId))
      || (msg && (msg.you && (msg.you.clientId || msg.you.id)));
    if (cand !== undefined && cand !== null && cand !== '') {
      state.clientId = String(cand);
      try {
        localStorage.setItem('ww-client-id', state.clientId);
      } catch (e) { /* ignore */ }
    }
  }
  try {
    var savedCid = localStorage.getItem('ww-client-id');
    if (savedCid) state.clientId = String(savedCid);
  } catch (e) { /* ignore */ }

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
        rememberClientId(msg);
        renderLobby(msg.lobby || {});
      } else if (msg.type === 'JOINED') {
        rememberClientId(msg);
        if (msg.playerId !== undefined && msg.playerId !== null) {
          state.playerId = msg.playerId;
          state.mode = 'player';
        }
        if (msg.token) {
          state.token = msg.token;
          try {
            localStorage.setItem(TOKEN_KEY, msg.token);
          } catch (e) { /* ignore */ }
        }
        state.selectedTarget = null;
        send({ type: 'REQUEST_SNAPSHOT' });
      } else if (msg.type === 'NAME_SET') {
        rememberClientId(msg);
        if (msg.token) {
          state.token = msg.token;
          try {
            localStorage.setItem(TOKEN_KEY, msg.token);
          } catch (e) { /* ignore */ }
        }
        if (msg.name !== undefined && msg.name !== null) {
          applyConfirmedName(String(msg.name));
        }
        if (nameMaskError) nameMaskError.hidden = true;
        send({ type: 'REQUEST_SNAPSHOT' });
      } else if (msg.type === 'JOIN_REJECTED') {
        // 無效 token 清除，避免無限重連迴圈
        if (/token|unknown/i.test(msg.reason || '')) {
          state.token = null;
          try { localStorage.removeItem(TOKEN_KEY); } catch (e) { /* ignore */ }
        }
        showLobbyError(friendlyReason(msg.reason));
        showError(friendlyReason(msg.reason));
      } else if (msg.type === 'LEFT_LOBBY') {
        // 大廳乾淨離開確認：座位已釋放＋廣播已送出，可以回主選單
        if (lobbyExitNav) lobbyExitNav();
      } else if (msg.type === 'IDLE_TAKEOVER') {
        // 掛機接管通知（只推被接管者本人）：拉一次快照，panel 以快照標記渲染
        send({ type: 'REQUEST_SNAPSHOT' });
      } else if (msg.type === 'ACTION_REJECTED') {
        showLobbyError(friendlyReason(msg.reason));
        showError(friendlyReason(msg.reason));
      } else if (msg.type === 'CHAT_MESSAGE') {
        pushChatMessage(msg);
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
        // 新契約同時走 lobby.engineStatus；舊版只有 MODEL_STATUS，轉成 engineStatus 餵給大廳角落
        state.engine = {
          state: msg.state,
          stage: msg.stage,
          downloaded: msg.downloaded,
          total: msg.total,
          info: msg.info,
          error: msg.error,
        };
        renderEngineCorner();
        // 遊戲狀態列也同步，避免空白等待
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
        } else if (msg.state === 'idle') {
          phaseEl.textContent = '引擎準備中…';
        }
      } else if (msg.type === 'PING') {
        send({ type: 'PONG' });
      } else if (msg.type === 'SHUTDOWN') {
        // 伺服器已關閉：停止重連，避免 onclose 覆寫訊息並無限重連
        left = true;
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

  // ---------- 大廳（三段式：參戰 / 觀戰+聊天 / 控制列） ----------

  function friendlyReason(reason) {
    var r = String(reason || '操作被拒絕');
    if (/名稱已被使用|重名|duplicate/i.test(r)) return '這名字有人用了，換一個吧';
    if (/名稱不可為空|不能空白|不可為空/i.test(r)) return '名字不能空白喔';
    if (/尚未參戰/.test(r)) return '你還沒參戰，先參戰或先取名吧';
    if (/only host/i.test(r) || /host/.test(r)) return '只有房主可以操作喔';
    if (/game started/i.test(r)) return '遊戲已經開打了，乖乖觀戰吧';
    if (/seat taken|occupied|taken|已有人|已佔用/i.test(r)) return '這位置剛被搶走，再按一次參戰';
    if (/unknown token/i.test(r)) return '連線身分過期，請重新參戰';
    return r;
  }

  function lobbyPlayerCount(lobby) {
    if (typeof lobby.playerCount === 'number') return lobby.playerCount;
    if (typeof lobby.expectedPlayerCount === 'number') return lobby.expectedPlayerCount;
    return (lobby.seats || []).length || 6;
  }

  function lobbyRandomEnabled(lobby) {
    var v = lobby.randomCount;
    if (typeof v === 'boolean') return v;
    if (typeof v === 'number') return v > 0;
    if (typeof lobby.randomEnabled === 'boolean') return lobby.randomEnabled;
    return false;
  }

  function mySeat(lobby) {
    if (state.playerId === null || !lobby.seats) return null;
    for (var i = 0; i < lobby.seats.length; i++) {
      if (lobby.seats[i].playerId === state.playerId) return lobby.seats[i];
    }
    return null;
  }

  function isSeated(lobby) {
    var s = mySeat(lobby);
    return !!(s && s.controlledBy === 'human');
  }

  function isHost(lobby) {
    var host = lobby.hostClientId;
    if (host === undefined || host === null || host === '') {
      // 舊後端無 host 概念：有座位的真人即視為可開局（相容舊行為）
      return isSeated(lobby) || state.playerId !== null;
    }
    if (state.clientId === null) return false;
    return String(host) === String(state.clientId);
  }

  function engineReady() {
    // 無 engine 資訊（舊後端）→ 視為就緒，不擋開局
    if (!state.engine) return true;
    return state.engine.state === 'ready';
  }

  function selfNames() {
    var names = [];
    try {
      var v2 = mynameInput && mynameInput.value ? mynameInput.value.trim() : '';
      if (v2) names.push(v2);
      var v3 = nameMaskInput && nameMaskInput.value ? nameMaskInput.value.trim() : '';
      if (v3) names.push(v3);
    } catch (e) { /* ignore */ }
    var seat = state.lobby ? mySeat(state.lobby) : null;
    if (seat && seat.name) names.push(String(seat.name));
    var me = state.lobby ? mySpectatorEntry(state.lobby) : null;
    if (me && me.name) names.push(String(me.name));
    return names;
  }

  function pushChatMessage(msg) {
    var from = msg.from;
    if (from && typeof from === 'object') from = from.name || from.clientId || '路人';
    from = from === undefined || from === null || from === '' ? '路人' : String(from);
    var text = String(msg.text === undefined || msg.text === null ? '' : msg.text).slice(0, 500);
    if (!text) return;
    var names = selfNames();
    var mine = false;
    for (var i = 0; i < names.length; i++) {
      if (names[i] && from === names[i]) {
        mine = true;
        break;
      }
    }
    state.chatLog.push({ from: from, text: text, ts: msg.ts || Date.now(), mine: mine });
    if (state.chatLog.length > 100) state.chatLog.splice(0, state.chatLog.length - 100);
    renderChatLog();
  }

  function fmtChatTime(ts) {
    try {
      var d = new Date(Number(ts));
      if (isNaN(d.getTime())) return '';
      var hh = String(d.getHours());
      if (hh.length < 2) hh = '0' + hh;
      var mm = String(d.getMinutes());
      if (mm.length < 2) mm = '0' + mm;
      return hh + ':' + mm;
    } catch (e) {
      return '';
    }
  }

  function renderChatLog() {
    if (!chatLog) return;
    if (state.chatLog.length === 0) {
      chatLog.innerHTML = '<div class="chat-empty">還沒人講話，先打聲招呼吧！</div>';
      return;
    }
    var html = '';
    for (var i = 0; i < state.chatLog.length; i++) {
      var m = state.chatLog[i];
      html += '<div class="chat-msg' + (m.mine ? ' mine' : '') + '">'
        + '<span class="chat-from">' + esc(m.from) + (m.mine ? '（我）' : '') + '</span>'
        + '<span class="chat-text">' + esc(m.text) + '</span>'
        + '<span class="chat-time">' + esc(fmtChatTime(m.ts)) + '</span>'
        + '</div>';
    }
    chatLog.innerHTML = html;
    chatLog.scrollTop = chatLog.scrollHeight;
  }

  function sendChat() {
    if (!chatInput) return;
    var text = chatInput.value.trim().slice(0, 500);
    if (!text) return;
    send({ type: 'CHAT_SEND', text: text });
    chatInput.value = '';
    if (chatCount) chatCount.textContent = '0 / 500';
  }

  function renderEngineCorner() {
    if (!engineText || !engineDot) return;
    var eng = state.engine;
    var box = document.getElementById('lobby-engine');
    engineDot.className = 'engine-dot';
    if (box) box.classList.remove('is-ready', 'is-error', 'is-busy');
    if (!eng) {
      engineText.textContent = '引擎準備中…';
      engineDot.classList.add('pulse');
      if (box) box.classList.add('is-busy');
      updateStartButton();
      return;
    }
    var pct = '';
    if (typeof eng.downloaded === 'number' && typeof eng.total === 'number' && eng.total > 0) {
      pct = Math.floor((eng.downloaded / eng.total) * 100) + '%（'
        + fmtMB1(eng.downloaded / 1048576) + ' / ' + fmtMB1(eng.total / 1048576) + ' MB）';
    } else if (typeof eng.downloaded === 'number' && eng.downloaded > 0) {
      pct = fmtMB1(eng.downloaded / 1048576) + ' MB';
    }
    var info = eng.info ? '（' + eng.info + '）' : '';
    if (eng.state === 'downloading') {
      var isEnv = eng.stage === 'llama-server';
      var looksUnzip = /解壓|unzip|extract/i.test(String(eng.info || '') + String(eng.stage || ''));
      engineText.textContent = looksUnzip
        ? '解壓中…' + info
        : (isEnv ? '下載執行環境…' : '模型下載中…') + pct;
      engineDot.classList.add('pulse');
      if (box) box.classList.add('is-busy');
    } else if (eng.state === 'starting') {
      engineText.textContent = '啟動執行環境中…' + info;
      engineDot.classList.add('pulse');
      if (box) box.classList.add('is-busy');
    } else if (eng.state === 'idle') {
      engineText.textContent = '載入中心跳…' + info;
      engineDot.classList.add('pulse');
      if (box) box.classList.add('is-busy');
    } else if (eng.state === 'ready') {
      engineText.textContent = '引擎就緒 ✅';
      engineDot.classList.add('ok');
      if (box) box.classList.add('is-ready');
    } else if (eng.state === 'error') {
      engineText.textContent = '啟動失敗：' + (eng.error || '未知錯誤');
      engineDot.classList.add('bad');
      if (box) box.classList.add('is-error');
    } else {
      engineText.textContent = '引擎準備中…';
      engineDot.classList.add('pulse');
      if (box) box.classList.add('is-busy');
    }
    updateStartButton();
  }

  // ---------- 取名閘門＋改名 ----------

  // 我的觀眾席（clientId 定位；舊後端無 clientId 時退回存檔暱稱比對）
  function mySpectatorEntry(lobby) {
    var list = lobby.spectators;
    if (!Array.isArray(list)) return null;
    if (state.clientId !== null && state.clientId !== undefined && state.clientId !== '') {
      for (var i = 0; i < list.length; i++) {
        var s = list[i];
        if (s && typeof s === 'object' && String(s.clientId) === String(state.clientId)) return s;
      }
      return null;
    }
    var saved = '';
    try {
      saved = localStorage.getItem(NAME_KEY) || '';
    } catch (e) { /* ignore */ }
    saved = saved.trim();
    if (!saved) return null;
    var names = spectatorNames(lobby);
    for (var j = 0; j < names.length; j++) {
      if (names[j] === saved) return { name: saved };
    }
    return null;
  }

  // 尚未命名＝沒座位＋觀眾名單無我 → 遮罩擋住大廳互動
  function needsNaming(lobby) {
    if (isSeated(lobby)) return false;
    return !mySpectatorEntry(lobby);
  }

  function applyConfirmedName(name) {
    try {
      localStorage.setItem(NAME_KEY, name);
    } catch (e) { /* ignore */ }
    if (mynameInput && document.activeElement !== mynameInput) mynameInput.value = name;
    if (nameMaskInput && document.activeElement !== nameMaskInput) nameMaskInput.value = name;
  }

  // 已命名身份：具名觀眾／改名列／存檔，參戰按鈕直接拿來 JOIN（未命名時取名遮罩擋住，不可達）
  function currentConfirmedName() {
    var v = mynameInput && mynameInput.value ? mynameInput.value.trim() : '';
    if (v) return v.slice(0, 12);
    var me = state.lobby ? mySpectatorEntry(state.lobby) : null;
    if (me && me.name) return String(me.name).slice(0, 12);
    try {
      var sn = localStorage.getItem(NAME_KEY) || '';
      sn = sn.trim();
      if (sn) return sn.slice(0, 12);
    } catch (e) { /* ignore */ }
    return '';
  }

  function submitName(inputEl) {
    var name = inputEl && inputEl.value ? inputEl.value.trim().slice(0, 12) : '';
    if (!name) {
      showLobbyError('名字不能空白喔');
      return;
    }
    var payload = { type: 'SET_NAME', name: name };
    if (state.token) payload.token = state.token;
    send(payload);
  }

  function spectatorNames(lobby) {
    var list = lobby.spectators;
    if (!Array.isArray(list)) return [];
    var out = [];
    for (var i = 0; i < list.length; i++) {
      var s = list[i];
      if (s === null || s === undefined) continue;
      if (typeof s === 'string') {
        if (s) out.push(s);
      } else if (typeof s === 'object') {
        var n = s.name || s.nick || s.clientId || s.id;
        if (n !== undefined && n !== null && String(n) !== '') out.push(String(n));
      }
    }
    return out;
  }

  function updateStartButton() {
    if (!startBtn) return;
    var lobby = state.lobby;
    if (!lobby) return;
    var host = isHost(lobby);
    var ready = engineReady();
    startBtn.disabled = !host || !ready;
    if (startHint) {
      if (!host) {
        startHint.textContent = '';
      } else if (!ready) {
        startHint.textContent = '引擎啟動中…就緒後才能開打';
      } else {
        var n = lobbyPlayerCount(lobby);
        var isRandom = lobbyRandomEnabled(lobby);
        startHint.textContent = isRandom
          ? '你是房主，開局時隨機（上限 ' + n + ' 人），隨時可以開打！'
          : '你是房主，' + n + ' 人局，隨時可以開打！';
      }
    }
  }

  function renderLobby(lobby) {
    lobby = lobby || {};
    if (!Array.isArray(lobby.seats)) lobby.seats = [];
    state.lobby = lobby;
    if (lobby.engineStatus && typeof lobby.engineStatus === 'object') {
      state.engine = lobby.engineStatus;
    }
    if (lobby.phase) {
      phaseEl.textContent = PHASE_LABELS[lobby.phase] || lobby.phase;
    }

    // 開打後把大廳收起來，交給 snapshot 流程
    if (lobby.started) {
      hideLobby();
      return;
    }
    state.mode = isSeated(lobby) ? 'player' : 'lobby';
    lobbyOverlay.hidden = false;

    renderSeats(lobby);
    renderSpectatorZone(lobby);
    renderHostControls(lobby);
    renderEngineCorner();
    renderChatLog();

    // 取名閘門：未命名先擋大廳互動，送出暱稱成為具名觀眾後才放行
    if (nameMask) {
      var need = needsNaming(lobby);
      if (need && nameMask.hidden) {
        try {
          var sn = localStorage.getItem(NAME_KEY) || '';
          if (sn && nameMaskInput && !nameMaskInput.value) nameMaskInput.value = sn.slice(0, 12);
        } catch (e) { /* ignore */ }
        if (nameMaskError) nameMaskError.hidden = true;
      }
      nameMask.hidden = !need;
    }
    // 具名後預填改名列，參戰不用重打
    var meEntry = mySpectatorEntry(lobby);
    var mySeatEntry = mySeat(lobby);
    var confirmed = (mySeatEntry && mySeatEntry.name) || (meEntry && meEntry.name) || '';
    if (confirmed) {
      try {
        localStorage.setItem(NAME_KEY, confirmed);
      } catch (e) { /* ignore */ }
      if (mynameInput && document.activeElement !== mynameInput && !mynameInput.value) mynameInput.value = confirmed;
    }
  }

  function renderSeats(lobby) {
    var seated = isSeated(lobby);
    var humans = 0;
    var firstEmpty = -1;
    for (var s = 0; s < lobby.seats.length; s++) {
      if (lobby.seats[s].controlledBy === 'human') humans++;
      if (firstEmpty < 0 && lobby.seats[s].controlledBy === 'empty') firstEmpty = lobby.seats[s].playerId;
    }
    if (lobbyCount) {
      lobbyCount.textContent = '（' + humans + ' / ' + lobbyPlayerCount(lobby) + ' 人參戰）';
    }
    // 純清單：無座號欄位，只列參戰者（有名物件）；沒人時顯示空態
    var html = '';
    if (lobby.seats.length === 0) {
      html = '<div class="msg">座位載入中…</div>';
    } else if (!seated) {
      if (firstEmpty > 0) {
        html += '<button type="button" id="lobby-join-btn" class="lobby-join-btn">＋ 參戰（自動配位）</button>';
      } else {
        html += '<div class="msg">參戰名額已滿，只能觀戰了。</div>';
      }
    }
    var shown = 0;
    for (var i = 0; i < lobby.seats.length; i++) {
      var seat = lobby.seats[i];
      if (seat.controlledBy !== 'human') continue;   // 開局前只有真人，沒有 AI 列
      var pid = seat.playerId;
      var isMine = state.playerId !== null && pid === state.playerId;
      shown++;
      html += '<div class="seat seat-row human' + (isMine ? ' mine' : '') + '">'
        + '<span class="seat-name">' + esc(seat.name || '無名氏') + '</span>'
        + '<span class="badge badge-human">🧑 真人</span>';
      if (seat.disconnected) {
        html += '<span class="badge badge-proxy">⚠️ AI 託管中</span>';
      }
      if (isMine) {
        html += '<button type="button" class="btn-ghost btn-small seat-leave" data-leave="' + pid + '">離座</button>';
      }
      html += '</div>';
    }
    if (lobby.seats.length > 0 && shown === 0) {
      html += '<div class="msg">目前還沒有人參戰，來當第一個吧！</div>';
    }
    lobbySeats.innerHTML = html || '<div class="msg">座位載入中…</div>';

    var joinBtn = document.getElementById('lobby-join-btn');
    if (joinBtn) {
      joinBtn.addEventListener('click', function () {
        var target = -1;
        for (var k = 0; k < lobby.seats.length; k++) {
          if (lobby.seats[k].controlledBy === 'empty') { target = lobby.seats[k].playerId; break; }
        }
        if (target < 0) return;
        var name = currentConfirmedName();
        if (name.length === 0) {
          showLobbyError('先取個名字再參戰吧');
          return;
        }
        send({ type: 'JOIN', playerId: target, name: name });
      });
    }
    var leaves = lobbySeats.querySelectorAll('button.seat-leave[data-leave]');
    for (var l = 0; l < leaves.length; l++) {
      leaves[l].addEventListener('click', function (ev) {
        ev.stopPropagation();
        state.playerId = null; // 樂觀切換：先當自己已離座，等下一次 LOBBY 校準
        send({ type: 'SPECTATE' });
        send({ type: 'REQUEST_SNAPSHOT' });
      });
    }
  }

  function renderSpectatorZone(lobby) {
    var names = spectatorNames(lobby);
    if (lobbySpecCount) {
      lobbySpecCount.textContent = names.length > 0 ? '（' + names.length + ' 人觀戰）' : '';
    }
    if (lobbySpectators) {
      if (names.length === 0) {
        lobbySpectators.innerHTML = '<span class="hint">目前沒有觀戰者，來當第一個吧！</span>';
      } else {
        var html = '';
        for (var i = 0; i < names.length; i++) {
          html += '<span class="spec-chip">👁️ ' + esc(names[i]) + '</span>';
        }
        lobbySpectators.innerHTML = html;
      }
    }
    var seated = isSeated(lobby);
    if (spectateBtn) {
      spectateBtn.hidden = !seated;
    }
    if (lobbyWatchHint) {
      lobbyWatchHint.textContent = seated ? '想休息就按「轉為觀戰」或自己座位的「離座」。' : '按「參戰」自動加入，座位由系統分配。';
    }
  }

  function renderHostControls(lobby) {
    var host = isHost(lobby);
    var count = lobbyPlayerCount(lobby);
    var random = lobbyRandomEnabled(lobby);
    if (playerCountSel) {
      if (playerCountSel.options.length === 0) {
        for (var n = 6; n <= 15; n++) {
          var opt = document.createElement('option');
          opt.value = String(n);
          opt.textContent = n + ' 人局';
          playerCountSel.appendChild(opt);
        }
      }
      suppressCountEvent = true;
      playerCountSel.value = String(count);
      // 互斥：隨機開啟時下拉禁用（上限凍結，改上限需先取消隨機），值仍跟快照一致
      playerCountSel.disabled = !host || random;
      if (random) playerCountSel.classList.add('is-random');
      else playerCountSel.classList.remove('is-random');
      suppressCountEvent = false;
    }
    if (randomCheck) {
      suppressRandomEvent = true;
      randomCheck.checked = random;
      randomCheck.disabled = !host;
      suppressRandomEvent = false;
    }
    // 隨機意義文案：所有人跟快照一致（host 看行內 hint，guest 看 guestNote）
    var randomHint = document.getElementById('lobby-random-hint');
    if (randomHint) {
      if (random) {
        randomHint.textContent = '開局時隨機（上限 ' + count + ' 人）';
        randomHint.hidden = host ? false : true;
      } else {
        randomHint.hidden = true;
      }
    }
    if (hostControls) hostControls.hidden = !host;
    if (guestNote) {
      guestNote.hidden = host;
      if (!host) {
        guestNote.textContent = random
          ? '房主開啟了隨機人數，開局時隨機（上限 ' + count + ' 人）！'
          : '房主正在設定人數，坐好準備開打！';
      }
    }
    updateStartButton();
  }

  function hideLobby() {
    lobbyOverlay.hidden = true;
  }

  startBtn.addEventListener('click', function () {
    if (startBtn.disabled) return;
    send({ type: 'START_GAME' });
  });

  if (playerCountSel) {
    playerCountSel.addEventListener('change', function () {
      if (suppressCountEvent || playerCountSel.disabled) return;
      var v = parseInt(playerCountSel.value, 10);
      if (v >= 6 && v <= 15) send({ type: 'SET_PLAYER_COUNT', count: v });
    });
  }

  if (randomCheck) {
    randomCheck.addEventListener('change', function () {
      if (suppressRandomEvent || randomCheck.disabled) return;
      send({ type: 'SET_RANDOM_COUNT', enabled: !!randomCheck.checked });
    });
  }

  if (spectateBtn) {
    spectateBtn.addEventListener('click', function () {
      state.playerId = null;
      send({ type: 'SPECTATE' });
      send({ type: 'REQUEST_SNAPSHOT' });
    });
  }

  if (chatSend) {
    chatSend.addEventListener('click', sendChat);
  }
  if (chatInput) {
    chatInput.addEventListener('keydown', function (ev) {
      if (ev.key === 'Enter' && !ev.shiftKey) {
        ev.preventDefault();
        sendChat();
      }
    });
    chatInput.addEventListener('input', function () {
      if (chatInput.value.length > 500) chatInput.value = chatInput.value.slice(0, 500);
      if (chatCount) chatCount.textContent = chatInput.value.length + ' / 500';
    });
  }

  try {
    var savedName = localStorage.getItem(NAME_KEY);
    if (savedName) {
      if (mynameInput && !mynameInput.value) mynameInput.value = savedName;
      if (nameMaskInput && !nameMaskInput.value) nameMaskInput.value = savedName;
    }
  } catch (e) { /* ignore */ }
  if (mynameInput) {
    mynameInput.addEventListener('input', function () {
      if (mynameInput.value.length > 12) mynameInput.value = mynameInput.value.slice(0, 12);
    });
    mynameInput.addEventListener('keydown', function (ev) {
      if (ev.key === 'Enter') {
        ev.preventDefault();
        submitName(mynameInput);
      }
    });
  }
  if (mynameBtn) {
    mynameBtn.addEventListener('click', function () {
      submitName(mynameInput);
    });
  }
  if (nameMaskInput) {
    nameMaskInput.addEventListener('input', function () {
      if (nameMaskInput.value.length > 12) nameMaskInput.value = nameMaskInput.value.slice(0, 12);
      if (nameMaskError) nameMaskError.hidden = true;
    });
    nameMaskInput.addEventListener('keydown', function (ev) {
      if (ev.key === 'Enter') {
        ev.preventDefault();
        submitName(nameMaskInput);
      }
    });
  }
  if (nameMaskBtn) {
    nameMaskBtn.addEventListener('click', function () {
      submitName(nameMaskInput);
    });
  }

  // 聊天室初始文案
  renderChatLog();

  // ---------- 白板 / 玩家卡片共用 ----------

  // onlyToday：GM 視角白板只顯示當天對話（GM snapshot 含全部天數，避免與下方對話紀錄區塊重複；一般快照無 day 欄位不受影響）
  function boardHtml(snapshot, onlyToday) {
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
      if (onlyToday && log[j].day !== undefined && log[j].day !== snapshot.day) continue;
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
      var pnameMap = snapshot.personalityNames || {};
      for (var g = 0; g < gmPlayers.length; g++) {
        var gp = gmPlayers[g];
        var cls = gp.alive ? 'alive' : 'dead';
        var roleZh = ROLE_DISPLAY[gp.role] || gp.role;
        var dispName = gp.controlledBy === 'ai' ? (pnameMap[gp.personality] || gp.name) : gp.name;
        html += '<div class="' + cls + '">P' + gp.id + ' ' + esc(dispName) + '（' + esc(roleZh) + '）</div>';
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

  // GM 夜間行動區塊：nightActions（當夜提交）＋ seer/guard/mason 跨天累積，按 day 分組
  function gmNightHtml(snapshot) {
    var html = '<h2>夜間行動</h2>';
    html += '<div class="msg">註：白板投票統計為跨天累計（GM 全覽語義）</div>';
    var acts = snapshot.nightActions || [];
    if (acts.length === 0) {
      html += '<div class="msg">本夜尚無提交</div>';
    } else {
      var labels = { wolf_kill: '人狼襲擊', seer_check: '查驗', guard_protect: '守護' };
      for (var i = 0; i < acts.length; i++) {
        var a = acts[i];
        html += '<div class="msg">P' + a.actorId + '→P' + a.targetId + '（' + esc(labels[a.type] || a.type) + '）</div>';
      }
    }
    html += gmGroupedHtml(snapshot.seerChecks, '查驗紀錄', function (c) {
      return 'P' + c.seerId + ' 查驗 P' + c.targetId + '=' + (c.result === 'werewolf' ? '人狼' : '村人');
    });
    html += gmGroupedHtml(snapshot.guardProtects, '守護紀錄', function (g) {
      return 'P' + g.guardId + ' 守護 P' + g.targetId;
    });
    html += gmGroupedHtml(snapshot.masonChatLog, '共有者夜聊', function (m) {
      return 'P' + m.playerId + '：' + esc(m.text);
    });
    return html;
  }

  // 通用 day 分組渲染（seer/guard/mason/對話共用）
  function gmGroupedHtml(entries, title, fmt) {
    var html = '<h2>' + esc(title) + '</h2>';
    var list = entries || [];
    if (list.length === 0) return html + '<div class="msg">無</div>';
    var byDay = {};
    var days = [];
    for (var i = 0; i < list.length; i++) {
      var d = list[i].day;
      if (!byDay[d]) { byDay[d] = []; days.push(d); }
      byDay[d].push(list[i]);
    }
    days.sort(function (a, b) { return a - b; });
    for (var k = 0; k < days.length; k++) {
      html += '<div class="msg">第 ' + days[k] + ' 天</div>';
      var arr = byDay[days[k]];
      for (var j = 0; j < arr.length; j++) {
        html += '<div class="msg">' + fmt(arr[j]) + '</div>';
      }
    }
    return html;
  }

  // GM 對話紀錄：全部 discussionLog 按 day 分組
  function gmDiscussHtml(snapshot) {
    return gmGroupedHtml(snapshot.discussionLog, '對話紀錄', function (e) {
      return 'P' + e.playerId + '：' + esc(e.text);
    });
  }

  // GM 除錯用：每輪 AI 決策 flag 統計（無資料時不渲染）
  function gmFlagHtml(snapshot) {
    var fs = snapshot.flagStats;
    if (!fs) return '';
    return '<h2>AI 決策</h2><div class="msg">AI 決策（每玩家最新）：決定投誰 '
      + esc(fs.decided) + '／棄票 ' + esc(fs.abstain) + '／資訊不足 ' + esc(fs.uncertain) + '</div>';
  }

  function renderSpectator(snapshot, isGm) {
    hideLobby();
    gmBtn.hidden = false;
    meEl.hidden = true;
    dayEl.textContent = '第 ' + snapshot.day + ' 天';
    phaseEl.textContent = PHASE_LABELS[snapshot.phase] || snapshot.phase;
    var html = boardHtml(snapshot, isGm);
    if (isGm) html += gmNightHtml(snapshot) + gmDiscussHtml(snapshot) + gmFlagHtml(snapshot);
    boardEl.innerHTML = html;
    boardEl.scrollTop = boardEl.scrollHeight;
    playersEl.innerHTML = playersHtml(snapshot, false);
      controlsBody.innerHTML = '<div class="msg">觀戰中…（真人請在大廳按參戰加入）</div>';
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

    // 掛機接管 panel：以快照標記為準，每次快照重算（多頁籤一致；重整頁面靠快照回來）
    if (you.takenOver) {
      controlsBody.innerHTML = '<div class="msg">你的座位已被 AI 接管（掛機）。拿回後回到未定，需重新決定。</div>'
        + '<div><button id="takeback-btn" type="button">拿回座位</button></div>';
      var takebackBtn = document.getElementById('takeback-btn');
      if (takebackBtn) {
        takebackBtn.addEventListener('click', function () {
          send({ type: 'RECONNECT', token: state.token });
        });
      }
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
        ? '<div><button id="unready-btn" type="button">收回準備</button></div>'
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

  // 大廳返回主選單：先送顯式離開（釋放座位＋觀眾下架＋host 轉移，即時廣播），
  // 收到 LEFT_LOBBY 確認或超時後跳轉。遊戲中此鈕隨大廳 overlay 隱藏，不觸發座位釋放。
  function exitLobbyToMenu() {
    if (left || lobbyExiting) return;
    lobbyExiting = true;
    if (lobbyExitBtn) lobbyExitBtn.disabled = true;
    send({ type: 'LEAVE_LOBBY' });
    var done = false;
    var go = function () {
      if (done) return;
      done = true;
      left = true; // 停止自動重連
      try {
        localStorage.removeItem(TOKEN_KEY);
      } catch (e) { /* ignore */ }
      try {
        if (ws) ws.close();
      } catch (e) { /* ignore */ }
      location.href = '/menu.html';
    };
    lobbyExitNav = go;
    setTimeout(go, 1500);
  }

  if (lobbyExitBtn) {
    lobbyExitBtn.addEventListener('click', exitLobbyToMenu);
  }

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
