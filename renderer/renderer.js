/**
 * 弹幕发射器 - 渲染进程控制器
 *
 * 职责：弹幕时钟控制、控制条交互、设置面板、点击穿透联动、全局快捷键响应。
 */
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);

  const els = {
    canvas: $('danmaku-canvas'),
    controlBar: $('control-bar'),
    btnPlay: $('btn-play'),
    iconPlay: $('icon-play'),
    iconPause: $('icon-pause'),
    timeDisplay: $('time-display'),
    timeTotal: $('time-total'),
    progress: $('progress'),
    offsetDisplay: $('offset-display'),
    btnOffsetMinus: $('btn-offset-minus'),
    btnOffsetPlus: $('btn-offset-plus'),
    btnPassthrough: $('btn-passthrough'),
    btnResize: $('btn-resize'),
    resizeFrame: $('resize-frame'),
    btnSettings: $('btn-settings'),
    btnClose: $('btn-close'),
    settingsPanel: $('settings-panel'),
    settingsBody: $('settings-body'),
    btnSettingsClose: $('btn-settings-close'),
    btnLoadFile: $('btn-load-file'),
    fileInput: $('file-input'),
    toast: $('toast'),
    passthroughHint: $('passthrough-hint')
  };

  const engine = new DanmakuEngine(els.canvas);

  const state = {
    settings: null,
    totalTime: 120,
    controlBarTimer: null,
    toastTimer: null,
    dragSeeking: false,
    resizeMode: false,
    resizeDrag: null,
    edgeHintTimer: null
  };

  // ---------------- 工具函数 ----------------

  function formatTime(sec) {
    const s = Math.max(0, Math.floor(sec));
    const m = Math.floor(s / 60);
    const r = s % 60;
    return `${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}`;
  }

  function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
  }

  let toastToken = 0;
  function showToast(text, duration) {
    clearTimeout(state.toastTimer);
    const token = ++toastToken;
    els.toast.textContent = text;
    els.toast.classList.add('visible');
    state.toastTimer = setTimeout(() => {
      if (token === toastToken) els.toast.classList.remove('visible');
    }, duration || 2200);
  }

  // ---------------- 控制条显隐 ----------------

  function showControlBar(force) {
    clearTimeout(state.controlBarTimer);
    els.controlBar.classList.add('visible');
    if (force !== true) {
      state.controlBarTimer = setTimeout(hideControlBar, 2600);
    }
  }

  function hideControlBar() {
    if (state.settingsPanelVisible || state.resizeMode) return;
    els.controlBar.classList.remove('visible');
  }

  function scheduleAutoHide() {
    clearTimeout(state.controlBarTimer);
    state.controlBarTimer = setTimeout(hideControlBar, 2600);
  }

  // ---------------- 弹幕控制 ----------------

  function togglePlay() {
    engine.togglePlay();
    syncPlayButton();
  }

  function syncPlayButton() {
    const playing = engine.playing;
    els.iconPlay.style.display = playing ? 'none' : '';
    els.iconPause.style.display = playing ? '' : 'none';
    els.btnPlay.title = playing ? '暂停（Ctrl+Alt+P）' : '播放（Ctrl+Alt+P）';
  }

  function seekTo(time) {
    engine.seek(time);
    syncTimeUI();
  }

  function syncTimeUI() {
    const t = engine.getTime();
    els.timeDisplay.textContent = formatTime(t);
    if (!state.dragSeeking) {
      els.progress.value = String(Math.min(t, state.totalTime));
    }
  }

  function adjustOffset(deltaMs) {
    const next = Math.max(-10000, Math.min(10000, state.settings.offsetMs + deltaMs));
    applyOffset(next);
  }

  function applyOffset(ms) {
    state.settings.offsetMs = ms;
    engine.setOffset(ms);
    els.offsetDisplay.textContent = `${ms > 0 ? '+' : ''}${ms}ms`;
    syncTimeUI();
  }

  // ---------------- 设置面板 ----------------

  const SETTING_DEFS = [
    { key: 'fontSize', label: '字号', min: 16, max: 40, step: 1, unit: 'px', fmt: (v) => `${v}px` },
    { key: 'speed', label: '滚动速度', min: 0.4, max: 2.0, step: 0.1, fmt: (v) => `${v.toFixed(1)}x` },
    { key: 'opacity', label: '透明度', min: 0.1, max: 1, step: 0.05, fmt: (v) => `${Math.round(v * 100)}%` },
    { key: 'maxActive', label: '同屏上限', min: 4, max: 30, step: 1, unit: '条', fmt: (v) => `${Math.round(v)} 条` },
    { key: 'trackCount', label: '轨道数', min: 2, max: 10, step: 1, unit: '', fmt: (v) => `${v} 轨` },
    { key: 'density', label: '弹幕密度', min: 0.2, max: 1, step: 0.05, fmt: (v) => `${Math.round(v * 100)}%` },
    { key: 'offsetMs', label: '偏移校准', min: -5000, max: 5000, step: 100, unit: 'ms', fmt: (v) => `${v > 0 ? '+' : ''}${v}ms` }
  ];

  function buildSettingsPanel() {
    const html = [];
    for (const def of SETTING_DEFS) {
      html.push(`
        <div class="setting-item ${def.key === 'offsetMs' ? 'setting-item--full' : ''}">
          <div class="setting-item__label">
            <span>${def.label}</span>
            <span class="setting-item__value" id="val-${def.key}"></span>
          </div>
          <input type="range" id="set-${def.key}" min="${def.min}" max="${def.max}" step="${def.step}">
        </div>
      `);
    }
    html.push(`
      <div class="setting-item setting-item--full">
        <div class="setting-item__label"><span>弹幕颜色</span></div>
        <div class="segmented" id="set-colorMode">
          <button data-value="original" title="使用数据自带颜色">原色</button>
          <button data-value="white" title="全部白色">纯白</button>
          <button data-value="vibrant" title="随机彩色">多彩</button>
        </div>
      </div>
    `);
    html.push(`
      <div class="setting-item setting-item--full builtin-source">
        <div class="setting-item__label"><span>内置数据源</span></div>
        <div id="builtin-episodes" class="builtin-episodes"><div class="builtin-loading">加载中…</div></div>
      </div>
    `);
    els.settingsBody.innerHTML = html.join('');

    for (const def of SETTING_DEFS) {
      const input = $('set-' + def.key);
      input.addEventListener('input', () => {
        const val = Number(input.value);
        if (def.key === 'offsetMs') {
          applyOffset(val);
        } else {
          state.settings[def.key] = val;
          engine.setParams({ [def.key]: val });
        }
        updateSettingValue(def);
        persistSettings();
      });
    }

    els.settingsBody.querySelectorAll('#set-colorMode button').forEach((btn) => {
      btn.addEventListener('click', () => {
        state.settings.colorMode = btn.dataset.value;
        engine.setParams({ colorMode: btn.dataset.value });
        els.settingsBody.querySelectorAll('#set-colorMode button').forEach((b) => {
          b.classList.toggle('selected', b === btn);
        });
        persistSettings();
      });
    });
  }

  function updateSettingValue(def) {
    const valEl = $('val-' + def.key);
    if (!valEl) return;
    const v = state.settings[def.key];
    valEl.textContent = def.fmt(v);
    const input = $('set-' + def.key);
    if (input) input.value = String(v);
  }

  function syncSettingsPanel() {
    for (const def of SETTING_DEFS) {
      updateSettingValue(def);
    }
    els.settingsBody.querySelectorAll('#set-colorMode button').forEach((b) => {
      b.classList.toggle('selected', b.dataset.value === state.settings.colorMode);
    });
  }

  function toggleSettingsPanel(force) {
    const open = force !== undefined ? force : !state.settingsPanelVisible;
    state.settingsPanelVisible = open;
    els.settingsPanel.classList.toggle('visible', open);
    if (open) {
      syncSettingsPanel();
      showControlBar(true);
    } else {
      scheduleAutoHide();
    }
  }

  // ---------------- 内置数据源 ----------------

  async function buildBuiltinSource() {
    const container = $('builtin-episodes');
    if (!container) return;
    let res;
    try {
      res = await window.danmaku.listBuiltin();
    } catch (_) {
      container.innerHTML = '<div class="builtin-loading">暂无内置数据</div>';
      return;
    }
    if (!res || !res.ok || !res.data || !res.data.episodes.length) {
      container.innerHTML = '<div class="builtin-loading">暂无内置数据，可用采集脚本抓取</div>';
      return;
    }
    container.innerHTML = '';
    const title = document.createElement('div');
    title.className = 'builtin-name';
    title.textContent = res.data.name;
    container.appendChild(title);

    for (const ep of res.data.episodes) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'builtin-ep';
      btn.innerHTML = `
        <span class="builtin-ep__title">${escapeHtml(ep.title || ep.vid)}</span>
        <span class="builtin-ep__count">${(ep.count || 0).toLocaleString()}</span>
      `;
      btn.addEventListener('click', () => loadDanmakuFile(ep.filePath));
      container.appendChild(btn);
    }
  }

  // ---------------- 设置持久化 ----------------

  let persistTimer = null;
  function persistSettings() {
    clearTimeout(persistTimer);
    persistTimer = setTimeout(() => {
      window.danmaku.saveSettings(state.settings);
    }, 300);
  }

  // ---------------- 点击穿透 ----------------

  function syncPassthroughUI(flag) {
    state.passthrough = flag;
    els.btnPassthrough.classList.toggle('active', flag);
    els.btnPassthrough.title = flag ? '点击穿透已开启（Ctrl+Alt+T）' : '点击穿透已关闭（Ctrl+Alt+T）';
    els.passthroughHint.classList.toggle('visible', flag);
    if (flag) {
      els.controlBar.classList.remove('visible');
      document.querySelector('.edge-hint')?.classList.remove('visible');
      clearTimeout(state.controlBarTimer);
    }
  }

  function isNearEdge(x, y, margin) {
    const m = margin || 8;
    return x <= m || x >= window.innerWidth - m || y <= m || y >= window.innerHeight - m;
  }

  // ---------------- 调整窗口大小（调整模式） ----------------

  const RESIZE_MIN_W = 320;
  const RESIZE_MIN_H = 200;

  async function enterResizeMode() {
    if (state.resizeMode) return;
    // 调整模式需要鼠标操作，先退出点击穿透
    if (state.passthrough) {
      await window.danmaku.setPassthrough(false).then(syncPassthroughUI);
    }
    state.resizeMode = true;
    els.resizeFrame.classList.add('visible');
    els.btnResize.classList.add('active');
    els.btnResize.title = '完成调整（Esc）';
    document.querySelector('.edge-hint')?.classList.remove('visible');
    toggleSettingsPanel(false);
    showControlBar(true);
    showToast('调整模式：拖动边角手柄调整大小，拖动空白处移动窗口，按 Esc 完成', 3200);
  }

  function exitResizeMode() {
    if (!state.resizeMode) return;
    state.resizeMode = false;
    state.resizeDrag = null;
    els.resizeFrame.classList.remove('visible');
    els.btnResize.classList.remove('active');
    els.btnResize.title = '调整窗口大小（拖动边角手柄）';
    scheduleAutoHide();
  }

  function startResizeDrag(e, type) {
    e.preventDefault();
    state.resizeDrag = {
      type,
      startX: e.screenX,
      startY: e.screenY,
      winX: window.screenX,
      winY: window.screenY,
      winW: window.outerWidth,
      winH: window.outerHeight
    };
  }

  function onResizeMove(e) {
    const d = state.resizeDrag;
    if (!d) return;
    const dx = e.screenX - d.startX;
    const dy = e.screenY - d.startY;
    let x = d.winX, y = d.winY, w = d.winW, h = d.winH;
    if (d.type.includes('w')) { x = d.winX + dx; w = d.winW - dx; }
    if (d.type.includes('e')) { w = d.winW + dx; }
    if (d.type.includes('n')) { y = d.winY + dy; h = d.winH - dy; }
    if (d.type.includes('s')) { h = d.winH + dy; }
    if (w < RESIZE_MIN_W) { w = RESIZE_MIN_W; if (d.type.includes('w')) x = d.winX + d.winW - RESIZE_MIN_W; }
    if (h < RESIZE_MIN_H) { h = RESIZE_MIN_H; if (d.type.includes('n')) y = d.winY + d.winH - RESIZE_MIN_H; }
    window.danmaku.resizeWindow({ x, y, width: w, height: h });
  }

  function endResizeDrag() {
    state.resizeDrag = null;
  }

  // ---------------- 快捷键 / IPC ----------------

  function handleCommand(cmd) {
    switch (cmd) {
      case 'togglePlay':
        togglePlay();
        break;
      case 'seekForward':
        seekTo(engine.getTime() + 5);
        showToast(`快进 5s → ${formatTime(engine.getTime())}`);
        break;
      case 'seekBackward':
        seekTo(engine.getTime() - 5);
        showToast(`快退 5s ← ${formatTime(engine.getTime())}`);
        break;
      case 'togglePassthrough':
        window.danmaku.togglePassthrough().then(syncPassthroughUI);
        break;
    }
  }

  // ---------------- 本地文件加载 ----------------

  async function loadDanmakuFile(filePath) {
    try {
      const list = await DanmakuDataLoader.loadFile(filePath);
      if (!list.length) {
        showToast('文件加载成功，但没有有效弹幕数据');
        return;
      }
      engine.setData(list);
      state.totalTime = Math.max(1, Math.ceil(list[list.length - 1].time));
      els.progress.max = String(state.totalTime);
      els.timeTotal.textContent = formatTime(state.totalTime);
      engine.seek(0);
      showToast(`已加载 ${list.length} 条弹幕 · 时长 ${formatTime(state.totalTime)}`);
    } catch (err) {
      showToast(`加载失败：${err.message}`, 3200);
    }
  }

  // ---------------- 初始化 ----------------

  async function init() {
    // 读取已保存设置
    try {
      state.settings = await window.danmaku.loadSettings();
    } catch (_) {
      state.settings = { ...engine.getParams(), offsetMs: 0, colorMode: 'original' };
    }

    engine.setParams({
      fontSize: state.settings.fontSize,
      speed: state.settings.speed,
      opacity: state.settings.opacity,
      trackCount: state.settings.trackCount,
      density: state.settings.density,
      colorMode: state.settings.colorMode,
      maxActive: state.settings.maxActive
    });
    engine.setOffset(state.settings.offsetMs);

    // 构建设置面板
    buildSettingsPanel();
    syncSettingsPanel();
    applyOffset(state.settings.offsetMs);
    buildBuiltinSource();

    // 加载内置演示数据
    const list = await DanmakuDataLoader.loadWithFallback('builtin');
    engine.setData(list);
    state.totalTime = Math.max(1, Math.ceil(list[list.length - 1].time));
    els.progress.max = String(state.totalTime);
    els.timeTotal.textContent = formatTime(state.totalTime);

    // 绑定事件
    bindEvents();

    // 自动播放
    engine.play();
    syncPlayButton();
    syncTimeUI();

    showToast('弹幕发射器已就绪 · 拖动窗口对齐视频区域');
  }

  function bindEvents() {
    els.btnPlay.addEventListener('click', togglePlay);
    els.btnClose.addEventListener('click', () => window.close());
    els.btnSettings.addEventListener('click', () => toggleSettingsPanel());
    els.btnSettingsClose.addEventListener('click', () => toggleSettingsPanel(false));
    els.btnPassthrough.addEventListener('click', () => {
      window.danmaku.togglePassthrough().then(syncPassthroughUI);
    });

    els.btnOffsetMinus.addEventListener('click', () => adjustOffset(-100));
    els.btnOffsetPlus.addEventListener('click', () => adjustOffset(100));

    // 进度条
    els.progress.addEventListener('input', () => {
      state.dragSeeking = true;
      const t = Number(els.progress.value);
      els.timeDisplay.textContent = formatTime(t);
    });
    els.progress.addEventListener('change', () => {
      state.dragSeeking = false;
      seekTo(Number(els.progress.value));
    });

    // 本地文件
    els.btnLoadFile.addEventListener('click', () => els.fileInput.click());
    els.fileInput.addEventListener('change', async () => {
      const file = els.fileInput.files && els.fileInput.files[0];
      els.fileInput.value = '';
      if (!file) return;
      const filePath = window.danmaku.getPathForFile(file);
      loadDanmakuFile(filePath);
    });

    // 调整模式
    els.btnResize.addEventListener('click', () => {
      if (state.resizeMode) exitResizeMode();
      else enterResizeMode();
    });
    els.resizeFrame.querySelectorAll('.resize-handle').forEach((h) => {
      h.addEventListener('mousedown', (e) => startResizeDrag(e, h.dataset.resize));
    });
    document.addEventListener('mousemove', onResizeMove);
    document.addEventListener('mouseup', endResizeDrag);
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && state.resizeMode) exitResizeMode();
    });

    // 控制条自动显隐 + 边缘提示
    window.addEventListener('mousemove', (e) => {
      if (state.resizeMode) return;
      if (state.passthrough) {
        // 穿透模式下，鼠标移到窗口边缘热区时自动退出
        if (isNearEdge(e.clientX, e.clientY)) {
          window.danmaku.setPassthrough(false).then(syncPassthroughUI);
          showToast('已退出点击穿透，可操作控制条');
        }
        return;
      }
      showControlBar();
      // 鼠标靠近窗口边缘时短暂显示边界，提示可调整范围
      if (isNearEdge(e.clientX, e.clientY, 14)) {
        document.querySelector('.edge-hint')?.classList.add('visible');
        clearTimeout(state.edgeHintTimer);
      } else {
        clearTimeout(state.edgeHintTimer);
        state.edgeHintTimer = setTimeout(() => {
          document.querySelector('.edge-hint')?.classList.remove('visible');
        }, 400);
      }
    });

    // 主进程全局快捷键
    window.danmaku.onShortcut(handleCommand);

    // 主进程穿透状态广播
    window.danmaku.onPassthrough(syncPassthroughUI);

    // 周期性刷新 UI 时间显示（节流，避免每帧更新 DOM）
    setInterval(() => {
      if (engine.playing || state.dragSeeking) syncTimeUI();
    }, 250);
  }

  // 启动
  window.addEventListener('DOMContentLoaded', init);
})();
