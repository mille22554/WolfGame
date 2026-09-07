/* 人狼遊戲 Phase 1 下載頁邏輯 */
(function () {
  'use strict';

  var statusEl = document.getElementById('download-status');
  var barEl = document.getElementById('progress-bar');
  var textEl = document.getElementById('progress-text');
  var retryBtn = document.getElementById('retry-btn');

  function fmtMB(n) {
    return (n / 1024 / 1024).toFixed(1);
  }

  var ws = new WebSocket('ws://' + location.host);
  ws.onmessage = function (ev) {
    var msg;
    try {
      msg = JSON.parse(ev.data);
    } catch (e) {
      return;
    }
    if (msg.type === 'PING') {
      ws.send(JSON.stringify({ type: 'PONG' }));
      return;
    }
    if (msg.type !== 'MODEL_STATUS') return;
    if (msg.state === 'downloading') {
      statusEl.textContent = '模型下載中…';
      if (msg.total > 0) {
        var pct = Math.floor((msg.downloaded / msg.total) * 100);
        barEl.style.width = pct + '%';
        textEl.textContent = pct + '%（' + fmtMB(msg.downloaded) + ' / ' + fmtMB(msg.total) + ' MB）';
      } else {
        textEl.textContent = fmtMB(msg.downloaded || 0) + ' MB';
      }
    } else if (msg.state === 'ready') {
      statusEl.textContent = '模型就緒，即將進入遊戲…';
      barEl.style.width = '100%';
      setTimeout(function () {
        location.href = '/';
      }, 2000);
    } else if (msg.state === 'error') {
      statusEl.textContent = '下載失敗：' + (msg.error || '未知錯誤');
      retryBtn.hidden = false;
    }
  };

  retryBtn.addEventListener('click', function () {
    location.reload();
  });
})();
