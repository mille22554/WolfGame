/* 人狼遊戲 Phase 3 下載頁邏輯（兩階段：llama-server / model） */
(function () {
  'use strict';

  var statusEl = document.getElementById('download-status');
  var barEl = document.getElementById('progress-bar');
  var textEl = document.getElementById('progress-text');
  var retryBtn = document.getElementById('retry-btn');

  function fmtMB(n) {
    return (n / 1024 / 1024).toFixed(1);
  }

  // 兩階段皆 ready 才跳轉：llama 階段出現過（downloading）則需等其 ready；
  // model ready 先到時排程跳轉，若 llama 階段隨後開始則取消排程改等 llama ready。
  var llamaActive = false;
  var llamaReady = false;
  var modelReady = false;
  var redirectTimer = null;

  function scheduleRedirect() {
    if (redirectTimer !== null) return;
    redirectTimer = setTimeout(function () {
      location.href = '/';
    }, 2000);
  }

  function cancelRedirect() {
    if (redirectTimer !== null) {
      clearTimeout(redirectTimer);
      redirectTimer = null;
    }
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
      if (msg.stage === 'llama-server') {
        llamaActive = true;
        cancelRedirect();
        statusEl.textContent = '下載執行環境（llama-server）…';
      } else {
        statusEl.textContent = '模型下載中…';
      }
      if (msg.total > 0) {
        var pct = Math.floor((msg.downloaded / msg.total) * 100);
        barEl.style.width = pct + '%';
        textEl.textContent = pct + '%（' + fmtMB(msg.downloaded) + ' / ' + fmtMB(msg.total) + ' MB）';
      } else {
        textEl.textContent = fmtMB(msg.downloaded || 0) + ' MB';
      }
    } else if (msg.state === 'ready') {
      if (msg.stage === 'llama-server') {
        llamaReady = true;
        barEl.style.width = '100%';
        if (modelReady) {
          statusEl.textContent = '就緒，即將進入遊戲…';
          scheduleRedirect();
        } else {
          statusEl.textContent = '執行環境就緒，準備下載模型…';
        }
      } else {
        // stage === 'model'（或舊版無 stage）：最後階段
        modelReady = true;
        barEl.style.width = '100%';
        if (!llamaActive || llamaReady) {
          statusEl.textContent = '模型就緒，即將進入遊戲…';
          scheduleRedirect();
        } else {
          statusEl.textContent = '模型就緒，啟動執行環境…';
        }
      }
    } else if (msg.state === 'error') {
      cancelRedirect();
      statusEl.textContent = '下載失敗：' + (msg.error || '未知錯誤');
      retryBtn.hidden = false;
    }
  };

  retryBtn.addEventListener('click', function () {
    location.reload();
  });
})();
