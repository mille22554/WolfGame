/* 人狼遊戲 主選單邏輯 */
(function () {
  'use strict';

  var pill = document.getElementById('model-pill');
  var pillText = document.getElementById('model-pill-text');
  var selectedLine = document.getElementById('selected-line');
  var startBtn = document.getElementById('start-btn');
  var modelsBtn = document.getElementById('models-btn');
  var hint = document.getElementById('menu-hint');
  var errorEl = document.getElementById('menu-error');

  function setPill(state, text) {
    pill.classList.remove('is-checking', 'is-ready', 'is-empty');
    if (state === 'ready') pill.classList.add('is-ready');
    else if (state === 'empty') pill.classList.add('is-empty');
    else pill.classList.add('is-checking');
    pillText.textContent = text;
  }

  function showError(msg) {
    if (!msg) {
      errorEl.hidden = true;
      errorEl.textContent = '';
      return;
    }
    errorEl.hidden = false;
    errorEl.textContent = msg;
  }

  function render(status) {
    var ready = !!status.modelReady;
    if (ready) {
      setPill('ready', '模型已就緒');
      startBtn.disabled = false;
      hint.textContent = '模型已就緒，可以開始遊戲。';
      if (status.selectedModel) {
        selectedLine.hidden = false;
        selectedLine.textContent = '目前模型：' + status.selectedModel;
      } else if (status.models && status.models.length > 0) {
        selectedLine.hidden = false;
        selectedLine.textContent = '目前模型：' + status.models[0].name;
      } else {
        selectedLine.hidden = true;
      }
    } else {
      setPill('empty', '尚未下載模型');
      startBtn.disabled = true;
      selectedLine.hidden = true;
      hint.textContent = '尚未下載模型，請先到「模型管理」下載。';
    }
  }

  function checkStatus() {
    showError('');
    fetch('/api/status', { cache: 'no-store' })
      .then(function (res) {
        if (!res.ok) throw new Error('狀態檢查失敗（' + res.status + '）');
        return res.json();
      })
      .then(function (data) {
        render(data);
      })
      .catch(function (err) {
        setPill('empty', '無法連接伺服器');
        startBtn.disabled = true;
        hint.textContent = '請確認遊戲伺服器正在執行，再重新整理本頁。';
        showError(err && err.message ? err.message : '連線失敗');
      });
  }

  startBtn.addEventListener('click', function () {
    if (startBtn.disabled) return;
    location.href = '/index.html';
  });

  modelsBtn.addEventListener('click', function () {
    location.href = '/models.html';
  });

  document.addEventListener('visibilitychange', function () {
    if (!document.hidden) checkStatus();
  });

  checkStatus();
})();
