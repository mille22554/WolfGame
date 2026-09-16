// ============================================================
// 狼人殺 · 前端 (app.js)
// 負責：頁面切換、房間渲染、星星裝飾、按鈕事件
// 純前端、無框架、無外部依賴；透過 WebSocket 連接 lobby-server
// （同源 ws://，server 在同一 port 提供靜態檔案與 WS）
// ============================================================

'use strict';

// ---------- 工具 ----------
const $ = (sel, root = document) => root.querySelector(sel);

// ---------- 前端狀態（房間資料以 server 為準） ----------
const state = {
  roomCode: '',
  nickname: '',
  isHost: false,
  isSpectating: false,
  started: false,
  maxPlayers: 15,
  randomCount: false,
  players: [], // MemberInfo[]：{ nickname, isHost, isSpectator }
};

// 重置為初始狀態（離開房間／被移出時使用）
function resetState() {
  state.roomCode = '';
  state.nickname = '';
  state.isHost = false;
  state.isSpectating = false;
  state.started = false;
  state.maxPlayers = 15;
  state.randomCount = false;
  state.players = [];
}

// ---------- WebSocket ----------
let ws = null;
let connected = false;
let intentionalClose = false; // 點「離開」主動關閉：不告警、不重連
let reconnectAttempts = 0;
const MAX_RECONNECT = 5;
const RECONNECT_DELAY_MS = 3000;

function connectWS() {
  if (location.protocol === 'file:') { connected = false; return; } // 靜態檔直接開啟時沒有 server
  if (ws && (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN)) return;
  const s = new WebSocket('ws://' + location.host);
  ws = s;
  s.onopen = () => { if (s !== ws) return; connected = true; reconnectAttempts = 0; };
  s.onmessage = (e) => {
    if (s !== ws) return; // 舊 socket 的訊息忽略
    let msg;
    try { msg = JSON.parse(e.data); } catch { return; }
    onServerMessage(msg);
  };
  s.onclose = () => {
    if (s !== ws) return;
    connected = false;
    if (intentionalClose) { intentionalClose = false; return; }
    alert('連線中斷');
    if (reconnectAttempts < MAX_RECONNECT) {
      reconnectAttempts++;
      setTimeout(connectWS, RECONNECT_DELAY_MS);
    }
  };
}

function wsSend(msg) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

// 使用者主動要求建立／加入但尚未連線：先嘗試（重新）連線，仍沒連上才告警
function ensureConnected() {
  if (connected) return true;
  if (location.protocol !== 'file:') {
    intentionalClose = false;
    reconnectAttempts = 0;
    connectWS();
  }
  if (!connected) alert('尚未連線到伺服器');
  return connected;
}

// ---------- 伺服器訊息分發 ----------
function onServerMessage(msg) {
  switch (msg.type) {
    case 'ROOM_JOINED':
    case 'SPECTATOR_JOINED':
      state.roomCode = msg.code;
      state.isHost = msg.isHost;
      state.isSpectating = msg.type === 'SPECTATOR_JOINED';
      state.started = msg.started;
      state.maxPlayers = msg.maxPlayers;
      state.randomCount = msg.randomCount;
      state.players = msg.players;
      enterRoom();
      break;
    case 'MESSAGE':
      addMessage(msg.from, msg.text, formatTime(msg.ts), msg.from === state.nickname);
      break;
    case 'PLAYER_JOINED':
      if (!state.players.some((p) => p.nickname === msg.nickname)) {
        // server 只給暱稱；先加佔位（遊戲已開始時新加入者會轉觀戰）
        state.players.push({ nickname: msg.nickname, isHost: false, isSpectator: state.started });
      }
      renderPlayers();
      break;
    case 'PLAYER_LEFT':
      state.players = state.players.filter((p) => p.nickname !== msg.nickname);
      renderPlayers();
      break;
    case 'HOST_CHANGED':
      state.isHost = msg.newHost === state.nickname;
      state.players.forEach((p) => { p.isHost = p.nickname === msg.newHost; });
      renderRoom();
      break;
    case 'SETTING_CHANGED':
      state.maxPlayers = msg.maxPlayers;
      state.randomCount = msg.randomCount;
      syncMaxPlayers(msg.maxPlayers);
      syncRandomCount(msg.randomCount);
      break;
    case 'GAME_STARTED':
      state.started = true;
      alert('遊戲開始！實際人數：' + msg.actualCount);
      break;
    case 'MEMBERS_CHANGED': {
      state.players = msg.players;
      state.isHost = msg.players.some((p) => p.isHost && p.nickname === state.nickname);
      const me = msg.players.find((p) => p.nickname === state.nickname);
      if (me) state.isSpectating = me.isSpectator;
      renderRoom();
      break;
    }
    case 'KICKED':
      alert('你被移出房間：' + msg.reason);
      resetState();
      resetHome();
      showPage('home');
      break;
    case 'ROOM_FULL':
      $('#overlay-full').hidden = false;
      break;
    case 'ERROR':
      alert(msg.message);
      break;
  }
}

// ---------- 裝飾：隨機星星（v6：180 顆、集中在上半部，避開村莊） ----------
function createStars(count = 180) {
  const sky = $('.stars');
  if (!sky) return;
  const frag = document.createDocumentFragment();
  for (let i = 0; i < count; i++) {
    const s = document.createElement('span');
    s.className = 'star' + (Math.random() < 0.15 ? ' star-warm' : '');
    const size = (Math.random() * 1.8 + 0.6).toFixed(1);
    s.style.width = size + 'px';
    s.style.height = size + 'px';
    s.style.left = (Math.random() * 100).toFixed(2) + '%';
    s.style.top = (Math.random() * 60).toFixed(2) + '%';
    s.style.setProperty('--d', (Math.random() * 3 + 2).toFixed(2) + 's');
    s.style.animationDelay = (Math.random() * 4).toFixed(2) + 's';
    frag.appendChild(s);
  }
  sky.appendChild(frag);
}

// ---------- 頁面切換 ----------
function showPage(name) {
  document.querySelectorAll('.page').forEach((p) => p.classList.remove('active'));
  const page = $('#page-' + name);
  if (page) page.classList.add('active');
}

// 「加入房間」流程是否已展開（第一次點擊展開代碼欄，第二次點擊才送出）
let joinOpen = false;

// 回首頁時重置為乾淨的初始狀態：顯示建立按鈕、隱藏並清空代碼欄、隱藏取消按鈕
function resetHome() {
  joinOpen = false;
  $('#btn-create').hidden = false;
  $('#join-code-slot').hidden = true;
  $('#btn-cancel-join').hidden = true;
  $('#join-code').value = '';
}

// ---------- Loading 過渡 ----------
function showLoading(done) {
  const ov = $('#overlay-loading');
  ov.hidden = false;
  setTimeout(() => {
    ov.hidden = true;
    if (done) done();
  }, 900);
}

// ---------- 房間渲染（不清聊天；重渲染時保留聊天歷史與輸入中文字） ----------
function renderRoom() {
  $('#room-code').textContent = state.roomCode;
  // 身分切換：高亮目前身分
  $('#mode-play').classList.toggle('active', !state.isSpectating);
  $('#mode-spec').classList.toggle('active', state.isSpectating);
  // 房主無論參戰／觀戰都保留房主工具（含開始遊戲）；觀戰提示只給非房主
  $('#host-tools').hidden = !state.isHost;
  $('#waiting-note').hidden = state.isHost || state.isSpectating;
  $('#spectate-note').hidden = !state.isSpectating || state.isHost;
  renderPlayers();
  syncMaxPlayers(state.maxPlayers);
  syncRandomCount(state.randomCount);
}

// 玩家列表：以 server 的 state.players 為準；角色圖示先用「?」佔位；
// 房主有 👑；房主可看到踢人按鈕；自己是 you
function renderPlayers() {
  const list = $('#player-list');
  list.innerHTML = '';

  // 空狀態：目前沒有成員
  if (state.players.length === 0) {
    const li = document.createElement('li');
    li.className = 'player-empty';
    li.textContent = '（目前沒有玩家）';
    list.appendChild(li);
  }

  state.players.forEach((m, i) => {
    const you = m.nickname === state.nickname;
    const li = document.createElement('li');
    li.className = 'player' + (you ? ' you' : '');

    const avatar = document.createElement('span');
    avatar.className = 'avatar';
    avatar.style.background = 'hsl(' + ((i * 137 + 260) % 360) + ' 45% 32%)';
    avatar.textContent = '?';
    avatar.title = '角色待分配';

    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = m.nickname;

    li.append(avatar, name);

    if (m.isHost) {
      const crown = document.createElement('span');
      crown.className = 'crown';
      crown.textContent = '👑';
      crown.title = '房主';
      li.appendChild(crown);
    }

    // 踢人：只有房主看得到，且不能踢自己
    if (state.isHost && m.nickname !== state.nickname) {
      const kick = document.createElement('button');
      kick.className = 'kick';
      kick.textContent = '✕';
      kick.title = '移出房間';
      li.appendChild(kick);
    }

    list.appendChild(li);
  });

  // 人數只算參戰玩家（不含觀戰者）
  $('#player-count').textContent = state.players.filter((m) => !m.isSpectator).length;
}

// ---------- 聊天 ----------
function addMessage(nick, text, time, isYou) {
  const box = $('#chat-messages');
  const empty = box.querySelector('.chat-empty');
  if (empty) empty.remove();

  const div = document.createElement('div');
  div.className = 'msg' + (isYou ? ' msg-you' : '');

  const head = document.createElement('div');
  head.className = 'msg-head';
  const t = document.createElement('span');
  t.className = 'msg-time';
  t.textContent = time;
  const n = document.createElement('span');
  n.className = 'msg-nick';
  n.textContent = isYou ? '你' : nick;
  head.append(t, n);

  const p = document.createElement('div');
  p.className = 'msg-text';
  p.textContent = text; // 用 textContent 避免 HTML 注入

  div.append(head, p);
  box.appendChild(div);
  box.scrollTop = box.scrollHeight;
}

function renderChat() {
  const box = $('#chat-messages');
  box.innerHTML = '';
  // 空狀態：不塞假訊息
  const empty = document.createElement('div');
  empty.className = 'chat-empty';
  empty.textContent = '（還沒有訊息）';
  box.appendChild(empty);
}

// 發送訊息（送給 server，由 server 廣播回給所有人；本地不先顯示，避免重複）
function sendChat() {
  const input = $('#chat-text');
  const text = input.value.trim();
  if (!text) return;
  wsSend({ type: 'SEND_MESSAGE', text });
  input.value = '';
  input.focus();
}

// ---------- 人數設定 ----------
// 滑桿值＝座位格數；隨機開啟時視為上限，實際人數開局才擲出
function syncMaxPlayers(v) {
  state.maxPlayers = v;
  $('#max-players').value = v;
  $('#player-max').textContent = v;
  const pct = ((v - 6) / (15 - 6)) * 100;
  $('#max-players').style.setProperty('--fill', pct + '%');
  updateCountValue();
}

// 隨機人數 toggle：開啟→滑桿禁用（上限保留），關閉→啟用
// （事件處理器送 SET_SETTING；server 廣播 SETTING_CHANGED 同步所有 client）
function syncRandomCount(v) {
  state.randomCount = v;
  $('#random-count').checked = v;
  $('#max-players').disabled = v;
  $('#random-hint').hidden = !v;
  updateCountValue();
}

// 數值顯示：隨機關閉＝定值，開啟＝上限（≤N，實際人數開局才知道）
function updateCountValue() {
  $('#max-players-value').textContent = state.randomCount ? '≤' + state.maxPlayers : String(state.maxPlayers);
}

// ---------- 時間格式（HH:MM） ----------
function formatTime(ts) {
  return new Date(ts).toTimeString().slice(0, 5);
}

// ---------- 進入房間（先走 loading 過渡） ----------
function enterRoom() {
  showLoading(() => {
    showPage('room');
    renderRoom();
    renderChat();
    $('#chat-text').value = '';
  });
}

// ---------- 事件綁定 ----------
function init() {
  createStars();
  showPage('home');

  // 建立房間 → 等 server 回 ROOM_JOINED 才進房
  $('#btn-create').addEventListener('click', () => {
    const nick = $('#nick').value.trim();
    if (!nick) { alert('請先輸入暱稱'); $('#nick').focus(); return; }
    if (!ensureConnected()) return;
    state.nickname = nick;
    wsSend({ type: 'CREATE_ROOM', nickname: nick });
  });

  // 加入房間：第一次點擊 → 在「建立房間」按鈕的位置展開代碼欄；第二次點擊 → 驗證並送出
  //（等 server 回 ROOM_JOINED／SPECTATOR_JOINED／ROOM_FULL／ERROR）
  $('#btn-join').addEventListener('click', () => {
    if (!joinOpen) {
      joinOpen = true;
      $('#btn-create').hidden = true;
      $('#join-code-slot').hidden = false;
      $('#btn-cancel-join').hidden = false;
      $('#join-code').focus();
      return;
    }
    const code = $('#join-code').value.trim();
    const nick = $('#nick').value.trim();
    if (!/^\d{4}$/.test(code)) { alert('房間代碼需為 4 位數字'); return; }
    if (!nick) { alert('請先輸入暱稱'); $('#nick').focus(); return; }
    if (!ensureConnected()) return;
    state.nickname = nick;
    state.roomCode = code;
    wsSend({ type: 'JOIN_ROOM', code, nickname: nick });
  });

  // 房間代碼：只保留數字，最多 4 位
  $('#join-code').addEventListener('input', (e) => {
    const clean = e.target.value.replace(/\D/g, '').slice(0, 4);
    if (clean !== e.target.value) e.target.value = clean;
  });

  // 取消加入流程 → 返回初始畫面
  $('#btn-cancel-join').addEventListener('click', resetHome);

  // 離開房間 → 關閉 WS（server 偵測斷線移除成員）、重置、回首頁
  $('#btn-leave').addEventListener('click', () => {
    intentionalClose = true;
    if (ws) ws.close();
    resetState();
    resetHome();
    showPage('home');
  });

  // 房間已滿 → 以觀戰進入（等 server 回 SPECTATOR_JOINED）
  $('#btn-spectate').addEventListener('click', () => {
    $('#overlay-full').hidden = true;
    wsSend({ type: 'JOIN_ROOM', code: state.roomCode, nickname: state.nickname, asSpectator: true });
  });

  // 房間已滿 → 取消（重置加入流程）
  $('#btn-cancel').addEventListener('click', () => {
    $('#overlay-full').hidden = true;
    resetHome();
    showPage('home');
  });

  // 開始遊戲
  $('#btn-start').addEventListener('click', () => {
    wsSend({ type: 'START_GAME', maxPlayers: state.maxPlayers, randomCount: state.randomCount });
  });

  // 踢人（事件委派）
  $('#player-list').addEventListener('click', (e) => {
    const btn = e.target.closest('.kick');
    if (!btn) return;
    const li = btn.closest('li');
    const nameEl = li ? li.querySelector('.name') : null;
    if (!nameEl) return;
    wsSend({ type: 'KICK_PLAYER', target: nameEl.textContent });
  });

  // 聊天發送
  $('#btn-send').addEventListener('click', sendChat);
  $('#chat-text').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') sendChat();
  });

  // 人數滑桿（隨機開啟時已禁用，不會觸發）；本地先同步顯示，server 廣播確認
  $('#max-players').addEventListener('input', (e) => {
    syncMaxPlayers(+e.target.value);
    wsSend({ type: 'SET_SETTING', maxPlayers: +e.target.value });
  });

  // 隨機人數 toggle：開啟→滑桿禁用（上限保留），實際人數開局才擲出
  $('#random-count').addEventListener('change', (e) => {
    syncRandomCount(e.target.checked);
    wsSend({ type: 'SET_SETTING', randomCount: e.target.checked });
  });

  // 身分切換：參戰／觀戰（server 廣播 MEMBERS_CHANGED 更新所有 client 的 UI）
  $('#mode-play').addEventListener('click', () => wsSend({ type: 'SET_MODE', mode: 'play' }));
  $('#mode-spec').addEventListener('click', () => wsSend({ type: 'SET_MODE', mode: 'spectate' }));

  connectWS();
}

document.addEventListener('DOMContentLoaded', init);
