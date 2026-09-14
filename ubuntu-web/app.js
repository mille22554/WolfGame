// ============================================================
// 狼人殺 · 前端原型 (app.js)
// 負責：頁面切換、房間渲染、星星裝飾、按鈕事件
// 純前端、無框架、無外部依賴；遊戲動作按鈕一律 alert('TODO')
// ============================================================

'use strict';

// ---------- 工具 ----------
const $ = (sel, root = document) => root.querySelector(sel);

// ---------- 前端狀態（演示用） ----------
const state = {
  roomCode: '',
  nickname: '',
  isHost: false,
  isSpectating: false,
  maxPlayers: 15,
};

// 演示用：房間裡的其他玩家
const DEMO_PLAYERS = [
  { nick: '月下影' },
  { nick: '夜行者' },
];

// 生成 4 位數字房間代碼（與加入房間的格式一致；首位不為 0）
function genCode() {
  let code = String(1 + Math.floor(Math.random() * 9));
  for (let i = 1; i < 4; i++) {
    code += Math.floor(Math.random() * 10);
  }
  return code;
}

// ---------- 裝飾：隨機星星 ----------
function createStars(count = 90) {
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
    s.style.top = (Math.random() * 100).toFixed(2) + '%';
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

// 回首頁時重置為乾淨的初始狀態：顯示建立按鈕、隱藏並清空代碼欄
function resetHome() {
  joinOpen = false;
  $('#btn-create').hidden = false;
  $('#join-code-slot').hidden = true;
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

// ---------- 房間渲染 ----------
function renderRoom() {
  $('#room-code').textContent = state.roomCode;
  $('#spectate-badge').hidden = !state.isSpectating;
  $('#host-tools').hidden = !state.isHost;
  $('#waiting-note').hidden = state.isHost || state.isSpectating;
  $('#spectate-note').hidden = !state.isSpectating;
  $('#chat-text').value = '';
  renderPlayers();
  renderChat();
  syncMaxPlayers(state.maxPlayers);
}

// 玩家列表：角色圖示先用「?」佔位；房主有 👑；房主可看到踢人按鈕
function renderPlayers() {
  const list = $('#player-list');
  list.innerHTML = '';

  const players = [];
  if (!state.isSpectating) {
    players.push({ nick: state.nickname || '你', host: state.isHost, you: true });
  }
  DEMO_PLAYERS.forEach((p, i) => {
    players.push({ nick: p.nick, host: !state.isHost && i === 0, you: false });
  });

  players.forEach((p, i) => {
    const li = document.createElement('li');
    li.className = 'player' + (p.you ? ' you' : '');

    const avatar = document.createElement('span');
    avatar.className = 'avatar';
    avatar.style.background = 'hsl(' + ((i * 137 + 260) % 360) + ' 45% 32%)';
    avatar.textContent = '?';
    avatar.title = '角色待分配';

    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = p.nick;

    li.append(avatar, name);

    if (p.host) {
      const crown = document.createElement('span');
      crown.className = 'crown';
      crown.textContent = '👑';
      crown.title = '房主';
      li.appendChild(crown);
    }

    // 踢人：只有房主看得到，且不能踢自己
    if (state.isHost && !p.you) {
      const kick = document.createElement('button');
      kick.className = 'kick';
      kick.textContent = '✕';
      kick.title = '移出房間';
      li.appendChild(kick);
    }

    list.appendChild(li);
  });

  $('#player-count').textContent = players.length;
}

// ---------- 聊天 ----------
function addMessage(nick, text, time, isYou) {
  const box = $('#chat-messages');

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
  addMessage('月下影', '大家好，準備好了嗎？', '21:03', false);
  addMessage('夜行者', '我來了，今晚月色不錯 🌙', '21:04', false);
  if (!state.isSpectating) {
    addMessage(state.nickname || '你', '人齊了，準備開局！', '21:05', true);
  }
}

// 發送訊息（純前端本地顯示，無後端）
function sendChat() {
  const input = $('#chat-text');
  const text = input.value.trim();
  if (!text) return;
  const time = new Date().toTimeString().slice(0, 5);
  addMessage(state.nickname || '你', text, time, true);
  input.value = '';
  input.focus();
}

// ---------- 人數上限 ----------
function syncMaxPlayers(v) {
  state.maxPlayers = v;
  $('#max-players').value = v;
  $('#max-players-value').textContent = v;
  $('#player-max').textContent = v;
  const pct = ((v - 2) / (18 - 2)) * 100;
  $('#max-players').style.setProperty('--fill', pct + '%');
}

// ---------- 進入房間（先走 loading 過渡） ----------
function enterRoom() {
  showLoading(() => {
    showPage('room');
    renderRoom();
  });
}

// ---------- 事件綁定 ----------
function init() {
  createStars();
  showPage('home');

  // 建立房間 → 自己是房主（讀取統一的暱稱欄）
  $('#btn-create').addEventListener('click', () => {
    const nick = $('#nick').value.trim();
    if (!nick) { alert('請先輸入暱稱'); $('#nick').focus(); return; }
    state.nickname = nick;
    state.isHost = true;
    state.isSpectating = false;
    state.roomCode = genCode();
    state.maxPlayers = 15;
    enterRoom();
  });

  // 加入房間：第一次點擊 → 在「建立房間」按鈕的位置展開代碼欄；第二次點擊 → 驗證並送出
  $('#btn-join').addEventListener('click', () => {
    if (!joinOpen) {
      joinOpen = true;
      $('#btn-create').hidden = true;
      $('#join-code-slot').hidden = false;
      $('#join-code').focus();
      return;
    }
    const code = $('#join-code').value.trim();
    const nick = $('#nick').value.trim();
    if (!/^\d{4}$/.test(code)) { alert('房間代碼需為 4 位數字'); return; }
    if (!nick) { alert('請先輸入暱稱'); $('#nick').focus(); return; }
    state.nickname = nick;
    state.isHost = false;
    state.isSpectating = false;
    state.roomCode = code;
    state.maxPlayers = 15;
    if (code === '9999') {
      // 演示：房間已滿 → 詢問是否以觀戰進入
      showLoading(() => { $('#overlay-full').hidden = false; });
    } else {
      enterRoom();
    }
  });

  // 房間代碼：只保留數字，最多 4 位
  $('#join-code').addEventListener('input', (e) => {
    const clean = e.target.value.replace(/\D/g, '').slice(0, 4);
    if (clean !== e.target.value) e.target.value = clean;
  });

  // 離開房間 → 回首頁（重置加入流程）
  $('#btn-leave').addEventListener('click', () => {
    state.isSpectating = false;
    resetHome();
    showPage('home');
  });

  // 房間已滿 → 以觀戰進入
  $('#btn-spectate').addEventListener('click', () => {
    $('#overlay-full').hidden = true;
    state.isSpectating = true;
    showPage('room');
    renderRoom();
  });

  // 房間已滿 → 取消（重置加入流程）
  $('#btn-cancel').addEventListener('click', () => {
    $('#overlay-full').hidden = true;
    resetHome();
    showPage('home');
  });

  // 開始遊戲（待接後端）
  $('#btn-start').addEventListener('click', () => alert('TODO'));

  // 踢人（待接後端）— 事件委派
  $('#player-list').addEventListener('click', (e) => {
    if (e.target.closest('.kick')) alert('TODO');
  });

  // 聊天發送（純前端本地顯示）
  $('#btn-send').addEventListener('click', sendChat);
  $('#chat-text').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') sendChat();
  });

  // 人數上限滑桿
  $('#max-players').addEventListener('input', (e) => syncMaxPlayers(+e.target.value));
}

document.addEventListener('DOMContentLoaded', init);
