/* 人狼遊戲 模型管理頁邏輯 */
(function () {
  'use strict';

  var pill = document.getElementById('models-pill');
  var pillText = document.getElementById('models-pill-text');
  var errorEl = document.getElementById('models-error');
  var backBtn = document.getElementById('back-btn');

  var progressCard = document.getElementById('progress-card');
  var progressTitle = document.getElementById('progress-title');
  var progressBar = document.getElementById('progress-bar');
  var progressText = document.getElementById('progress-text');

  var emptyCard = document.getElementById('empty-card');
  var downloadBtn = document.getElementById('download-btn');

  var listCard = document.getElementById('list-card');
  var modelList = document.getElementById('model-list');
  var downloadMoreBtn = document.getElementById('download-more-btn');

  var backendState = document.getElementById('backend-state');
  var backendError = document.getElementById('backend-error');
  var backendBtns = {
    auto: document.getElementById('backend-auto'),
    cpu: document.getElementById('backend-cpu'),
    gpu: document.getElementById('backend-gpu'),
  };

  var downloading = false;
  var selecting = false;

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

  function fmtMB(n) {
    var v = Number(n);
    if (!isFinite(v)) return String(n);
    return v.toFixed(1);
  }

  function setProgress(pct, label) {
    progressBar.style.width = pct + '%';
    progressText.textContent = label;
  }

  function showProgress(stage) {
    downloading = true;
    progressCard.hidden = false;
    progressTitle.textContent = stage === 'llama-server' ? '下載執行環境…' : '模型下載中…';
    downloadBtn.disabled = true;
    downloadMoreBtn.disabled = true;
    setPill('checking', '下載中…');
  }

  function hideProgress() {
    downloading = false;
    progressCard.hidden = true;
    downloadBtn.disabled = false;
    downloadMoreBtn.disabled = false;
  }

  function render(status) {
    var models = (status && status.models) || [];
    var selected = status ? status.selectedModel : null;
    var ready = !!(status && status.modelReady);

    if (models.length === 0) {
      emptyCard.hidden = false;
      listCard.hidden = true;
      if (!downloading) setPill('empty', ready ? '模型已就緒' : '尚未下載模型');
    } else {
      emptyCard.hidden = true;
      listCard.hidden = false;
      if (!downloading) setPill('ready', '模型已就緒（' + models.length + ' 個）');
      renderList(models, selected);
    }
  }

  function renderList(models, selected) {
    modelList.innerHTML = '';
    // 預設選中第一個（若 server 未回 selectedModel）
    var effective = selected;
    if (!effective && models.length > 0) effective = models[0].name;

    models.forEach(function (m) {
      var isSel = m.name === effective;

      var item = document.createElement('button');
      item.type = 'button';
      item.className = 'model-item' + (isSel ? ' selected' : '');
      item.setAttribute('aria-pressed', isSel ? 'true' : 'false');

      var radio = document.createElement('span');
      radio.className = 'model-radio';
      radio.setAttribute('aria-hidden', 'true');

      var body = document.createElement('span');
      body.className = 'model-body';

      var name = document.createElement('span');
      name.className = 'model-name';
      name.textContent = m.name;

      var meta = document.createElement('span');
      meta.className = 'model-meta';
      var sizePart = (m.sizeMB !== undefined && m.sizeMB !== null) ? fmtMB(m.sizeMB) + ' MB' : '';
      var tagPart = m.name.indexOf('Qwen3-4B') !== -1 ? '預設模型' : '自訂模型';
      meta.textContent = sizePart ? sizePart + ' · ' + tagPart : tagPart;

      body.appendChild(name);
      body.appendChild(meta);

      var badge = document.createElement('span');
      badge.className = 'model-badge';
      badge.textContent = isSel ? '已選擇' : '選擇';

      item.appendChild(radio);
      item.appendChild(body);
      item.appendChild(badge);

      if (!isSel) {
        item.addEventListener('click', function () {
          selectModel(m.name);
        });
      }

      modelList.appendChild(item);
    });
  }

  function fetchStatus() {
    fetch('/api/status', { cache: 'no-store' })
      .then(function (res) {
        if (!res.ok) throw new Error('狀態檢查失敗（' + res.status + '）');
        return res.json();
      })
      .then(function (data) {
        showError('');
        if (!downloading) render(data);
        else if (data.models && data.models.length > 0) renderList(data.models, data.selectedModel);
      })
      .catch(function (err) {
        setPill('empty', '無法連接伺服器');
        showError(err && err.message ? err.message : '連線失敗');
      });
  }

  function selectModel(name) {
    if (selecting || downloading) return;
    selecting = true;
    showError('');
    fetch('/api/model/select', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: name }),
    })
      .then(function (res) {
        if (!res.ok) throw new Error('選擇失敗（' + res.status + '）');
        return res.json();
      })
      .then(function () {
        fetchStatus();
      })
      .catch(function (err) {
        showError(err && err.message ? err.message : '選擇失敗');
      })
      .finally(function () {
        selecting = false;
      });
  }

  function triggerDownload() {
    if (downloading) return;
    showError('');
    showProgress('model');
    setProgress(0, '開始下載…');
    fetch('/api/model/download', { method: 'POST' })
      .then(function (res) {
        if (!res.ok) throw new Error('下載啟動失敗（' + res.status + '）');
      })
      .catch(function (err) {
        hideProgress();
        showError(err && err.message ? err.message : '下載啟動失敗');
      });
  }

  downloadBtn.addEventListener('click', triggerDownload);
  downloadMoreBtn.addEventListener('click', triggerDownload);

  backBtn.addEventListener('click', function () {
    location.href = '/menu.html';
  });

  // WebSocket：接收 MODEL_STATUS 廣播
  function connectWS() {
    var ws;
    try {
      ws = new WebSocket('ws://' + location.host);
    } catch (e) {
      return;
    }
    ws.onmessage = function (ev) {
      var msg;
      try {
        msg = JSON.parse(ev.data);
      } catch (e) {
        return;
      }
      if (msg.type === 'PING') {
        try {
          ws.send(JSON.stringify({ type: 'PONG' }));
        } catch (e) { /* ignore */ }
        return;
      }
      if (msg.type !== 'MODEL_STATUS') return;
      if (msg.state === 'downloading') {
        showProgress(msg.stage || 'model');
        if (msg.total > 0) {
          var pct = Math.floor((msg.downloaded / msg.total) * 100);
          progressTitle.textContent = msg.stage === 'llama-server' ? '下載執行環境…' : '模型下載中…';
          setProgress(pct, pct + '%（' + fmtMB(msg.downloaded / 1024 / 1024) + ' / ' + fmtMB(msg.total / 1024 / 1024) + ' MB）');
        } else {
          setProgress(0, (msg.downloaded ? fmtMB(msg.downloaded / 1024 / 1024) : '0.0') + ' MB');
        }
      } else if (msg.state === 'starting') {
        showProgress(msg.stage || 'llama-server');
        progressTitle.textContent = '啟動執行環境…' + (msg.info ? '（' + msg.info + '）' : '');
        // 不重置 bar（binary 已下載完時 bar 可能已 100%，只改文字保留進度）
        progressText.textContent = '啟動執行環境…' + (msg.info ? '（' + msg.info + '）' : '');
      } else if (msg.state === 'ready') {
        if (msg.stage === 'llama-server') {
          progressTitle.textContent = '執行環境就緒，準備下載模型…';
          setProgress(100, '執行環境就緒');
          return;
        }
        setProgress(100, '下載完成');
        progressTitle.textContent = '下載完成';
        hideProgress();
        fetchStatus();
      } else if (msg.state === 'error') {
        hideProgress();
        showError('下載失敗：' + (msg.error || '未知錯誤'));
      }
    };
    ws.onclose = function () {
      // 斷線 3 秒後重連（僅維持進度監聽，不影響列表）
      setTimeout(connectWS, 3000);
    };
  }

  // 後端三檔（自動／CPU／GPU）：設定持久化，手動優先於自動
  // 只寫檔不熱切換：POST 成功回來的 note 暫存，下次 repaint 一併顯示（沿用 hint 狀態文字樣式）
  var backendNote = '';
  function paintBackend(current) {
    var labels = { auto: '自動', cpu: 'CPU', gpu: 'GPU' };
    Object.keys(backendBtns).forEach(function (k) {
      var b = backendBtns[k];
      if (!b) return;
      var active = k === current;
      b.className = active ? 'btn-primary btn-small' : 'btn-ghost btn-small';
      b.setAttribute('aria-pressed', active ? 'true' : 'false');
    });
    if (backendState) backendState.textContent = '目前：' + (labels[current] || current) + (backendNote ? '（' + backendNote + '）' : '');
  }

  function showBackendError(msg) {
    if (!backendError) return;
    if (!msg) {
      backendError.hidden = true;
      backendError.textContent = '';
      return;
    }
    backendError.hidden = false;
    backendError.textContent = msg;
  }

  function fetchBackend() {
    fetch('/api/backend', { cache: 'no-store' })
      .then(function (res) {
        if (!res.ok) throw new Error('後端狀態讀取失敗（' + res.status + '）');
        return res.json();
      })
      .then(function (data) {
        showBackendError('');
        paintBackend(data.backend || 'auto');
      })
      .catch(function (err) {
        if (backendState) backendState.textContent = '讀取失敗';
        showBackendError(err && err.message ? err.message : '讀取失敗');
      });
  }

  function setBackend(pref) {
    showBackendError('');
    backendNote = '';
    paintBackend(pref);
    fetch('/api/backend', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ backend: pref }),
    })
      .then(function (res) {
        if (!res.ok) throw new Error('切換失敗（' + res.status + '）');
        return res.json();
      })
      .then(function (data) {
        if (data && data.note) backendNote = data.note;
        fetchBackend();
      })
      .catch(function (err) {
        showBackendError(err && err.message ? err.message : '切換失敗');
        fetchBackend();
      });
  }

  Object.keys(backendBtns).forEach(function (k) {
    var b = backendBtns[k];
    if (b) b.addEventListener('click', function () { setBackend(k); });
  });

  fetchStatus();
  fetchBackend();
  connectWS();
})();
