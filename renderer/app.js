/**
 * 弹幕观影 · 一体化主界面控制器
 *
 * 模式：
 *  - web   在线浏览：<webview> 打开任意影视页面，弹幕由主进程注入页面桥渲染并绑定视频时间轴
 *  - local 本地播放：自带 <video>，弹幕 canvas 覆盖画面、时钟绑定 video
 *
 * 数据：内置剧集 / 已采集列表 / 本地 JSON 三路统一加载（loadSource）
 */
(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const api = window.danmaku;

  const VIDEO_EXT = /\.(mp4|mkv|webm|mov|avi|flv|wmv|m4v|ts|mp3|m4a|flac|wav)$/i;
  const DM_EXT = /\.json$/i;
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

  const els = {
    // 顶栏
    modeSeg: document.querySelectorAll('.seg-btn'),
    btnBack: $('btn-back'), btnForward: $('btn-forward'), btnRefresh: $('btn-refresh'),
    address: $('address'),
    btnDmToggle: $('btn-dm-toggle'),
    btnFetchTop: $('btn-fetch'),
    btnSidebar: $('btn-sidebar'), btnSettings: $('btn-settings'),
    btnMin: $('btn-min'), btnMax: $('btn-max'), btnClose: $('btn-close'),
    // 舞台
    webPane: $('web-pane'), localPane: $('local-pane'),
    guest: $('guest'),
    stageStatus: $('stage-status'),
    localStage: $('local-stage'), localVideo: $('local-video'), localCanvas: $('local-canvas'),
    localDrop: $('local-drop'), localFileName: $('local-file-name'),
    btnOpenVideo: $('btn-open-video'), btnEject: $('btn-eject'),
    // 控制条
    ctlPlay: $('ctl-play'), icPlay: document.querySelector('#ctl-play .ic-play'),
    icPause: document.querySelector('#ctl-play .ic-pause'),
    ctlBack5: $('ctl-back5'), ctlFwd5: $('ctl-fwd5'),
    ctlTimeCur: $('ctl-time-cur'), ctlTimeTotal: $('ctl-time-total'), ctlSeek: $('ctl-seek'),
    ctlMsMinus: $('ctl-ms-minus'), ctlMsPlus: $('ctl-ms-plus'), ctlOffset: $('ctl-offset'),
    ctlFull: $('ctl-full'), ctlSettings: $('ctl-settings'),
    // 侧栏
    sidebar: $('sidebar'), btnSideClose: $('btn-side-close'),
    feedCard: $('feed-card'), feedTitle: $('feed-title'), feedMeta: $('feed-meta'),
    btnFeedReload: $('btn-feed-reload'), btnFeedClear: $('btn-feed-clear'),
    fetchVid: $('fetch-vid'), btnScanVid: $('btn-scan-vid'), fetchTitle: $('fetch-title'),
    btnFetchStart: $('btn-fetch-start'), btnFetchCancel: $('btn-fetch-cancel'),
    fetchProgress: $('fetch-progress'), fetchProgressText: $('fetch-progress-text'),
    btnShowDir: $('btn-show-dir'), collectedList: $('collected-list'),
    builtinSearch: $('builtin-search'), builtinList: $('builtin-list'),
    builtinCount: $('builtin-count'), btnOpenDanmaku: $('btn-open-danmaku'),
    // 设置
    drawer: $('settings-drawer'), btnSettingsClose: $('btn-settings-close'),
    btnOpenLegacy: $('btn-open-legacy'),
    setSize: $('set-size'), outSize: $('out-size'),
    setSpeed: $('set-speed'), outSpeed: $('out-speed'),
    setOpacity: $('set-opacity'), outOpacity: $('out-opacity'),
    setMax: $('set-max'), outMax: $('out-max'),
    setTracks: $('set-tracks'), outTracks: $('out-tracks'),
    setDensity: $('set-density'), outDensity: $('out-density'),
    setOffset: $('set-offset'), outOffset: $('out-offset'),
    colorModeBtns: document.querySelectorAll('#color-mode button'),
    toast: $('toast')
  };

  // ---------------- 状态 ----------------

  const state = {
    mode: 'web',            // web | local
    settings: null,
    dmOn: true,             // 弹幕层开关
    current: null,          // 当前弹幕数据源 { filePath, title, count, list? }
    webVideo: null,         // 最近一次 web 视频状态
    builtinEpisodes: [],
    collected: [],
    fetching: false,
    seekDragging: false,
    toastTimer: null,
    sideOpen: true,
    settingsOpen: false,
    feedPushedFile: null,   // 主进程 / 页面桥当前持有的弹幕源文件（模式切换时据此避免重复下发）
    feedValid: false        // 已下发数据是否仍与网页视频匹配（换集 / 换源后置 false）
  };

  // 本地播放弹幕引擎
  let localEngine = null;
  let localVideoLoaded = false;

  // ---------------- 工具 ----------------

  function fmtTime(sec) {
    if (!Number.isFinite(sec) || sec < 0) sec = 0;
    const s = Math.floor(sec);
    const m = Math.floor(s / 60);
    const h = Math.floor(m / 60);
    const r = s % 60;
    return h > 0
      ? `${h}:${String(m % 60).padStart(2, '0')}:${String(r).padStart(2, '0')}`
      : `${m}:${String(r).padStart(2, '0')}`;
  }

  function toast(msg, type = 'info', ms = 2600) {
    clearTimeout(state.toastTimer);
    els.toast.textContent = msg;
    els.toast.className = `toast ${type}`;
    els.toast.hidden = false;
    state.toastTimer = setTimeout(() => { els.toast.hidden = true; }, ms);
  }

  function basename(p) {
    const parts = String(p).replace(/\\/g, '/').split('/');
    return parts[parts.length - 1] || p;
  }

  // ---------------- 设置 ----------------

  function setRangeFill(input) {
    const min = Number(input.min || 0);
    const max = Number(input.max || 1);
    const val = Number(input.value);
    const span = max - min;
    const pct = span > 0 ? ((val - min) / span) * 100 : 0;
    input.style.setProperty('--fill', `${clamp(pct, 0, 100)}%`);
  }

  function initSettingsUI() {
    const s = state.settings;
    const bindRange = (el, out, key, format) => {
      const min = Number(el.min || 0);
      const max = Number(el.max || 1);
      let initVal = Number(s[key]);
      if (!Number.isFinite(initVal)) initVal = 0;
      if (key === 'speed') initVal = Math.round(initVal * 10) / 10;
      if (key === 'opacity') initVal = Math.round(initVal * 100) / 100;
      const clamped = clamp(initVal, min, max);
      el.value = String(clamped);
      out.textContent = format ? format(clamped) : clamped;
      setRangeFill(el);
      // 旧版本遗留越界值（如 ±10000ms 偏移）校正并落盘
      if (clamped !== initVal) applySetting({ [key]: clamped });
      el.addEventListener('input', () => {
        let val = Number(el.value);
        if (key === 'speed') val = Math.round(val * 10) / 10;
        if (key === 'opacity') val = Math.round(val * 100) / 100;
        out.textContent = format ? format(val) : val;
        setRangeFill(el);
        applySetting({ [key]: val });
      });
    };
    bindRange(els.setSize, els.outSize, 'fontSize', (v) => v);
    bindRange(els.setSpeed, els.outSpeed, 'speed', (v) => v.toFixed(1));
    bindRange(els.setOpacity, els.outOpacity, 'opacity', (v) => Number(v).toFixed(2));
    bindRange(els.setMax, els.outMax, 'maxActive', (v) => Math.round(v));
    bindRange(els.setTracks, els.outTracks, 'trackCount', (v) => v);
    bindRange(els.setDensity, els.outDensity, 'density', (v) => v.toFixed(1));
    bindRange(els.setOffset, els.outOffset, 'offsetMs', (v) => v);

    // 颜色模式
    els.colorModeBtns.forEach((b) => {
      b.classList.toggle('active', b.dataset.mode === s.colorMode);
      b.addEventListener('click', () => {
        els.colorModeBtns.forEach((x) => x.classList.remove('active'));
        b.classList.add('active');
        applySetting({ colorMode: b.dataset.mode });
      });
    });
  }

  let _saveTimer = null;
  function applySetting(patch) {
    const merged = { ...state.settings, ...patch };
    state.settings = merged;
    clearTimeout(_saveTimer);
    _saveTimer = setTimeout(() => api.saveSettings(patch), 250);
    // 同步到本地引擎 + 网页桥（主进程收到 patch 会全量推送给桥）
    api.webApplySettings(patch);
    if (localEngine) {
      localEngine.setParams({
        fontSize: merged.fontSize,
        speed: merged.speed,
        opacity: merged.opacity,
        trackCount: merged.trackCount,
        density: merged.density,
        colorMode: merged.colorMode,
        maxActive: merged.maxActive
      });
      localEngine.setOffset(merged.offsetMs);
    }
  }

  // ---------------- 数据源加载 ----------------

  function updateFeedCard() {
    const cur = state.current;
    if (cur) {
      els.feedCard.classList.remove('hidden');
      els.feedTitle.textContent = cur.title || basename(cur.filePath);
      const t = `${cur.count != null ? `${cur.count.toLocaleString()} 条弹幕` : ''}${cur.filePath ? ` · ${basename(cur.filePath)}` : ''}`;
      els.feedMeta.textContent = t;
    } else {
      els.feedCard.classList.add('hidden');
    }
    // 列表高亮
    document.querySelectorAll('.item-list li').forEach((li) => {
      li.classList.toggle('active', li.dataset.path === (cur && cur.filePath));
    });
  }

  /** 统一加载数据源：按当前模式分发 */
  async function loadSource(filePath, title) {
    if (!filePath) return;
    const display = title || basename(filePath).replace(/\.json$/i, '');
    if (state.mode === 'local') {
      const res = await api.loadFile(filePath);
      if (!res || !res.ok) {
        toast(`弹幕文件读取失败：${res && res.error || '未知错误'}`, 'error');
        return false;
      }
      state.current = { filePath, title: display, count: res.data.length, list: res.data };
      localEngine.setData(res.data);
      localEngine.seek(localVideo.currentTime || 0);
      const v = localVideo;
      if (v && !v.paused && !v.ended) localEngine.play();
      updateFeedCard();
      toast(`已加载：${display}（${res.data.length.toLocaleString()} 条）`, 'success');
      return true;
    }
    // web 模式：写入 dm-feed 活跃数据并推送页面桥
    const res = await api.setActiveFeed({ filePath, title: display });
    if (!res || !res.ok) {
      toast(`弹幕数据下发失败：${res && res.error || '未知错误'}`, 'error');
      return false;
    }
    state.current = { filePath, title: res.title || display, count: res.count };
    state.feedPushedFile = filePath;
    state.feedValid = true;
    updateFeedCard();
    const found = state.webVideo && state.webVideo.found;
    toast(found
      ? `弹幕已叠加到视频：${res.title || display}`
      : `已设置弹幕源：${res.title || display}（页面检测到视频后自动叠加）`, 'success', 3400);
    return true;
  }

  function clearSource() {
    state.current = null;
    state.feedPushedFile = null;
    state.feedValid = false;
    api.clearActiveFeed();
    if (modeTargetIs('web')) api.webControl('clearData');
    else if (localEngine) localEngine.setData([]);
    updateFeedCard();
  }

  function reloadSource() {
    const cur = state.current;
    if (!cur) { toast('当前未加载弹幕数据', 'warn'); return; }
    loadSource(cur.filePath, cur.title);
  }

  // ---------------- 网页模式 ----------------

  function isWebMode() { return state.mode === 'web'; }
  function modeTargetIs(m) { return state.mode === m; }

  function currentWebTime() {
    const st = state.webVideo;
    return st && st.found ? st.time : (localVideoLoaded ? localVideo.currentTime : 0);
  }

  function guestURL() {
    try { return els.guest.getURL() || ''; } catch (_) { return ''; }
  }

  function navigate(raw) {
    let u = String(raw || '').trim();
    if (!u) return;
    if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(u)) {
      // 带点域名 → 补 https；否则交给搜索引擎
      if (/^(localhost|[\w-]+(\.[\w-]+)+)(:\d+)?([/?#].*)?$/.test(u)) {
        u = /^localhost/.test(u) ? `http://${u}` : `https://${u}`;
      } else {
        u = `https://www.baidu.com/s?wd=${encodeURIComponent(u)}`;
      }
    }
    try {
      const p = els.guest.loadURL(u);
      if (p && typeof p.catch === 'function') {
        p.catch((err) => {
          if (state.mode === 'web') {
            setStageStatus(`页面加载失败：${(err && err.message) || err}`, false);
          }
        });
      }
    } catch (err) {
      if (state.mode === 'web') setStageStatus(`导航出错：${(err && err.message) || err}`, false);
    }
    els.address.blur();
  }

  function syncNavUI() {
    const url = guestURL();
    els.address.value = url;
    let canBack = false; let canForward = false;
    try { canBack = els.guest.canGoBack(); canForward = els.guest.canGoForward(); } catch (_) { /* ignore */ }
    els.btnBack.disabled = !canBack;
    els.btnForward.disabled = !canForward;
  }

  let _stageStatusText = '';
  let _stageStatusBusy = false;
  function setStageStatus(text, busy) {
    text = text || '';
    busy = Boolean(busy);
    if (!text) {
      if (!els.stageStatus.hidden) els.stageStatus.hidden = true;
      _stageStatusText = '';
      _stageStatusBusy = false;
      return;
    }
    if (!els.stageStatus.hidden && text === _stageStatusText && busy === _stageStatusBusy) return;
    _stageStatusText = text;
    _stageStatusBusy = busy;
    els.stageStatus.hidden = false;
    els.stageStatus.innerHTML = `${busy ? '<span class="spinner"></span>' : ''}<span></span>`;
    els.stageStatus.lastElementChild.textContent = text;
  }

  // ---------------- 本地模式 ----------------

  function computeVideoRect() {
    const v = els.localVideo;
    const sw = els.localStage.clientWidth;
    const sh = els.localStage.clientHeight;
    if (!v.videoWidth || !sw || !sh) return { left: 0, top: 0, width: sw, height: sh };
    const vr = v.videoWidth / v.videoHeight;
    const cr = sw / sh;
    let width = sw; let height = sh;
    if (vr > cr) { height = sw / vr; } else { width = sh * vr; }
    return { left: (sw - width) / 2, top: (sh - height) / 2, width, height };
  }

  function syncLocalCanvas() {
    if (!localEngine || !localVideoLoaded) return;
    const r = computeVideoRect();
    els.localCanvas.style.left = `${r.left}px`;
    els.localCanvas.style.top = `${r.top}px`;
    els.localCanvas.style.width = `${Math.round(r.width)}px`;
    els.localCanvas.style.height = `${Math.round(r.height)}px`;
    localEngine.setViewport(Math.round(r.width), Math.round(r.height));
  }

  async function loadLocalVideo(path) {
    if (!path) return;
    localVideoLoaded = true;
    els.localVideo.src = `dm-video://local/?p=${encodeURIComponent(path)}`;
    els.localFileName.textContent = basename(path);
    els.btnEject.hidden = false;
    els.localDrop.style.opacity = '0';
    els.localDrop.style.pointerEvents = 'none';
    // 尝试自动播放；失败则等待用户点击控制条
    try { await els.localVideo.play(); } catch (_) { /* 用户手势后播放 */ }
  }

  function ejectVideo() {
    els.localVideo.pause();
    els.localVideo.removeAttribute('src');
    els.localVideo.load();
    localVideoLoaded = false;
    els.btnEject.hidden = true;
    els.localFileName.textContent = '未打开视频';
    els.localDrop.style.opacity = '';
    els.localDrop.style.pointerEvents = '';
    if (localEngine) localEngine.pause();
    updateCtl(false, 0, 0);
  }

  // ---------------- 播放控制（控制条/快捷键共用） ----------------

  function updatePlayIcon(playing) {
    if (els.ctlPlay) els.ctlPlay.classList.toggle('is-playing', !!playing);
  }

  function ctlPlaying() {
    if (state.mode === 'web') {
      const st = state.webVideo;
      return !!(st && st.found && st.playing);
    }
    return !!(localVideoLoaded && !els.localVideo.paused && !els.localVideo.ended);
  }

  function togglePlay() {
    if (state.mode === 'web') {
      if (!state.webVideo || !state.webVideo.found) { toast('当前页面未检测到视频', 'warn'); return; }
      if (state.webVideo.playing) api.webControl('pause');
      else api.webControl('play');
      return;
    }
    if (!localVideoLoaded) { toast('请先打开本地视频', 'warn'); return; }
    const v = els.localVideo;
    if (v.paused || v.ended) v.play().catch(() => toast('无法自动播放，请点击视频画面', 'warn'));
    else v.pause();
  }

  function seekBy(delta) {
    const t = currentWebTime() + delta;
    if (state.mode === 'web') api.webControl('seek', Math.max(0, t));
    else {
      const v = els.localVideo;
      if (!localVideoLoaded) return;
      v.currentTime = clamp(t, 0, v.duration || 0);
      if (localEngine) localEngine.seek(v.currentTime);
    }
  }

  function updateCtl(playing, cur, total) {
    updatePlayIcon(playing);
    if (state.seekDragging) return; // 拖进度过程中不被视频状态回传覆盖
    els.ctlTimeCur.textContent = fmtTime(cur);
    els.ctlTimeTotal.textContent = fmtTime(total);
    if (!state.seekDragging) {
      els.ctlSeek.max = String(total || 0);
      els.ctlSeek.value = String(cur || 0);
      setRangeFill(els.ctlSeek);
    }
  }

  function adjustOffset(delta) {
    const next = clamp((state.settings.offsetMs || 0) + delta, -5000, 5000);
    els.setOffset.value = next;
    els.outOffset.textContent = next;
    setRangeFill(els.setOffset);
    applySetting({ offsetMs: next });
    els.ctlOffset.textContent = `偏移 ${next > 0 ? '+' : ''}${next}ms`;
  }

  function syncOffsetChip() {
    const off = state.settings.offsetMs || 0;
    els.ctlOffset.textContent = `偏移 ${off > 0 ? '+' : ''}${off}ms`;
  }

  // ---------------- 弹幕层开关 ----------------

  function toggleDanmaku() {
    state.dmOn = !state.dmOn;
    els.btnDmToggle.classList.toggle('on', state.dmOn);
    if (state.mode === 'web') api.webControl('setVisible', state.dmOn);
    else els.localCanvas.style.display = state.dmOn ? '' : 'none';
    toast(state.dmOn ? '弹幕已开启' : '弹幕已隐藏', 'info', 1200);
  }

  // ---------------- 侧栏与抽屉 ----------------

  function setSidebar(open) {
    state.sideOpen = open;
    els.sidebar.classList.toggle('open', open);
    els.btnSidebar.classList.toggle('active', open);
    els.btnFetchTop.classList.toggle('active', false);
  }

  function setDrawer(open) {
    state.settingsOpen = open;
    if (open) setSidebar(false);
    els.drawer.hidden = !open;
  }

  // ---------------- 采集 ----------------

  function renderCollected() {
    els.collectedList.innerHTML = '';
    if (!state.collected.length) {
      const li = document.createElement('li');
      li.className = 'item-empty';
      li.textContent = '暂无采集记录';
      els.collectedList.appendChild(li);
      return;
    }
    for (const e of state.collected) {
      const li = document.createElement('li');
      li.dataset.path = e.filePath;
      const t = document.createElement('span');
      t.className = 'item-text';
      t.textContent = `${e.title} (${e.vid})`;
      const c = document.createElement('small');
      c.textContent = `${e.count.toLocaleString()} 条`;
      t.appendChild(c);
      const b = document.createElement('button');
      b.className = 'item-load';
      b.textContent = '加载';
      b.addEventListener('click', () => loadSource(e.filePath, e.title));
      li.appendChild(t); li.appendChild(b);
      els.collectedList.appendChild(li);
    }
  }

  async function refreshCollected() {
    const res = await api.listCollected();
    state.collected = res && res.ok ? res.data || [] : [];
    renderCollected();
  }

  function setFetching(flag) {
    state.fetching = flag;
    els.btnFetchStart.disabled = flag;
    els.btnFetchCancel.disabled = !flag;
    els.btnScanVid.disabled = flag;
    els.fetchVid.disabled = flag;
    els.fetchProgress.hidden = !flag;
  }

  function onFetchProgress(p) {
    if (!state.fetching) return;
    const vid = p.vid || '';
    if (p.phase === 'done') {
      els.fetchProgressText.textContent = `完成：共获取 ${(p.fetched || 0).toLocaleString()} 条原始弹幕`;
      return;
    }
    if (p.cancelled) {
      els.fetchProgressText.textContent = '已取消';
      return;
    }
    els.fetchProgressText.textContent =
      `vid ${vid} · 已扫描约 ${(p.currentMin || 0)} 分钟 · 获取 ${(p.fetched || 0).toLocaleString()} 条`;
  }

  const VID_ONLY_RE = /^[a-zA-Z][a-zA-Z0-9]{7,12}$/;   // 裸 vid（腾讯约 11 位）
  let vidProbeTimer = null;

  /** 输入（链接或 vid）→ vid；解析失败时回传原因，便于给出准确提示 */
  async function resolveFetchVid(raw) {
    const input = String(raw || '').trim();
    if (!input) return { vid: '' };
    if (VID_ONLY_RE.test(input)) return { vid: input };
    const r = await api.extractVid(input);
    return {
      vid: (r && r.ok && r.vid) || '',
      title: (r && r.title) || '',
      error: (r && r.error) || ''
    };
  }

  /** 粘贴/输入链接后自动识别并回填 vid（防抖；识别不出时静默或提示原因） */
  function scheduleVidProbe(delay = 450) {
    clearTimeout(vidProbeTimer);
    vidProbeTimer = setTimeout(async () => {
      if (state.fetching) return;
      const raw = els.fetchVid.value.trim();
      if (!raw || VID_ONLY_RE.test(raw)) return;
      const { vid, title, error } = await resolveFetchVid(raw);
      if (vid) {
        els.fetchVid.value = vid;
        if (title && !els.fetchTitle.value.trim()) els.fetchTitle.value = title;
        toast(`已识别 vid：${vid}`, 'success');
      } else if (error) {
        toast(error, 'warn', 4200);
      }
    }, delay);
  }

  async function startFetch() {
    const raw = els.fetchVid.value.trim();
    let vid = '';
    let hint = '';
    if (raw) {
      const r = await resolveFetchVid(raw);
      vid = r.vid;
      hint = r.error || '';
      if (r.title && !els.fetchTitle.value.trim()) els.fetchTitle.value = r.title;
    }
    if (!vid) {
      // 输入为空或不可解析时，退回用当前播放地址识别
      const url = guestURL();
      if (url) {
        const r = await resolveFetchVid(url);
        if (r.vid) { vid = r.vid; hint = ''; }
      }
    }
    if (!vid) {
      toast(hint || '未能识别 vid：请粘贴腾讯视频播放页链接（如 v.qq.com/x/cover/…/xxx.html）或直接填 vid', 'warn', 4800);
      return;
    }
    els.fetchVid.value = vid;
    const title = els.fetchTitle.value.trim() || '';
    setFetching(true);
    els.fetchProgressText.textContent = '开始采集…';
    try {
      const res = await api.fetchStart({ input: vid, title });
      setFetching(false);
      if (res && res.cancelled) {
        toast(`已取消（已获取 ${(res.partial || 0).toLocaleString()} 条）`, 'warn');
      } else if (res && res.ok) {
        toast(`采集完成：${(res.count || 0).toLocaleString()} 条弹幕`, 'success');
        await refreshCollected();
        // 自动作为当前数据源
        if (res.filePath) {
          const t = res.title || title || vid;
          state.fetching = false;
          await loadSource(res.filePath, t);
        }
      } else {
        toast(`采集失败：${res && res.error || '未知错误'}`, 'error');
      }
    } catch (err) {
      setFetching(false);
      toast(`采集异常：${err.message || err}`, 'error');
    }
  }

  // ---------------- 内置数据渲染 ----------------

  function renderBuiltin(filter) {
    const list = els.builtinList;
    list.innerHTML = '';
    const kw = (filter || '').trim().toLowerCase();
    const data = state.builtinEpisodes.filter((e) => !kw || e.title.toLowerCase().includes(kw));
    if (!data.length) {
      const li = document.createElement('li');
      li.className = 'item-empty';
      li.textContent = '无匹配剧集';
      list.appendChild(li);
      return;
    }
    for (const e of data) {
      const li = document.createElement('li');
      li.dataset.path = e.filePath;
      const t = document.createElement('span');
      t.className = 'item-text';
      t.textContent = e.title;
      if (e.count) {
        const c = document.createElement('small');
        c.textContent = `${e.count.toLocaleString()} 条`;
        t.appendChild(c);
      }
      const b = document.createElement('button');
      b.className = 'item-load';
      b.textContent = '加载';
      b.addEventListener('click', () => loadSource(e.filePath, e.title));
      li.appendChild(t); li.appendChild(b);
      list.appendChild(li);
    }
  }

  async function refreshBuiltin() {
    const res = await api.listBuiltin();
    if (!res || !res.ok || !res.data) return;
    state.builtinEpisodes = res.data.episodes || [];
    els.builtinCount.textContent = state.builtinEpisodes.length ? `${state.builtinEpisodes.length} 集` : '';
    renderBuiltin(els.builtinSearch.value);
  }

  // ---------------- 模式切换 ----------------

  async function setMode(mode) {
    if (state.mode === mode) return;
    state.mode = mode;
    document.querySelectorAll('.seg-btn').forEach((b) => b.classList.toggle('active', b.dataset.mode === mode));
    els.webPane.classList.toggle('active', mode === 'web');
    els.localPane.classList.toggle('active', mode === 'local');
    // 避免网页与本地同时出声
    if (mode === 'web') {
      if (localVideoLoaded && !els.localVideo.paused) els.localVideo.pause();
    } else {
      api.webControl('pause'); // 暂停网页后台视频，避免双音源
      if (state.webVideo) state.webVideo = { ...state.webVideo, playing: false };
      updatePlayIcon(false);
    }
    // 地址栏仅网页模式可用；全屏仅本地模式
    const navBtns = [els.btnBack, els.btnForward, els.btnRefresh, els.address];
    navBtns.forEach((n) => { if (n) n.disabled = mode !== 'web'; });
    els.ctlFull.hidden = mode !== 'local';

    if (mode === 'web') {
      // 若当前数据源尚未被主进程 / 页面桥持有（如先前在本地模式加载），静默补发一次
      const cur = state.current;
      if (cur && cur.filePath && state.feedValid && cur.filePath !== state.feedPushedFile) {
        const res = await api.setActiveFeed({ filePath: cur.filePath, title: cur.title });
        if (res && res.ok) {
          state.feedPushedFile = cur.filePath;
          state.current.count = res.count;
          updateFeedCard();
        }
      }
      const found = state.webVideo && state.webVideo.found;
      setStageStatus(found ? '' : '当前页面未检测到视频。打开剧集后，弹幕将自动叠加并同步', false);
    } else {
      setStageStatus('');
      // 把当前数据注入本地引擎
      const cur = state.current;
      if (cur && cur.filePath) {
        if (!cur.list) {
          const res = await api.loadFile(cur.filePath);
          if (res && res.ok) {
            cur.list = res.data;
            cur.count = res.data.length;
          }
        }
        if (cur.list) {
          localEngine.setData(cur.list);
          if (localVideoLoaded && !els.localVideo.paused) localEngine.play();
        }
      }
      updateFeedCard();
    }
    updateCtlFromSource();
  }

  function updateCtlFromSource() {
    if (state.mode === 'web') {
      const st = state.webVideo;
      if (st && st.found) updateCtl(st.playing, st.time, st.duration);
      else updateCtl(false, 0, 0);
    } else if (localVideoLoaded) {
      const v = els.localVideo;
      updateCtl(!v.paused && !v.ended, v.currentTime, v.duration || 0);
    } else {
      updateCtl(false, 0, 0);
    }
  }

  // ---------------- 全局快捷键 / IPC ----------------

  function handleShortcut(cmd) {
    switch (cmd) {
      case 'togglePlay':
        togglePlay();
        break;
      case 'seekForward':
        seekBy(5);
        break;
      case 'seekBackward':
        seekBy(-5);
        break;
      case 'toggleDanmaku':
        toggleDanmaku();
        break;
      case 'reloadDanmaku':
        reloadSource();
        break;
      default:
        break;
    }
  }

  function bindIpc() {
    api.onShortcut(handleShortcut);
    api.onMaximized((flag) => {
      els.btnMax.title = flag ? '还原' : '最大化';
      els.btnMax.classList.toggle('restore', flag);
    });

    // 网页模式状态
    api.onVideoState((st) => {
      const prevFound = state.webVideo && state.webVideo.found;
      state.webVideo = st || { found: false };
      if (state.mode === 'web') {
        if (st && st.found) {
          setStageStatus('');
          updateCtl(st.playing, st.time, st.duration);
        } else {
          updateCtl(false, 0, 0);
          setStageStatus('当前页面未检测到视频。打开剧集后，弹幕将自动叠加并同步', false);
        }
      }
      // 首次在网页发现视频且已有数据源未推送（此时 main 会自动推送）
    });

    api.onVideoChanged(() => {
      // 主进程已清空页面桥持有的弹幕源：标记失效，避免模式切换时错误地自动补发旧数据
      state.feedPushedFile = null;
      state.feedValid = false;
      if (state.mode === 'web') {
        toast('检测到换集 / 切换片源，弹幕已清空。请重新选择弹幕数据', 'warn', 5000);
      }
    });

    api.onWebNav((nav) => {
      if (nav && nav.url) els.address.value = nav.url;
      try {
        els.btnBack.disabled = !nav.canGoBack;
        els.btnForward.disabled = !nav.canGoForward;
      } catch (_) { /* ignore */ }
    });

    api.onFetchProgress(onFetchProgress);
  }

  // ---------------- 事件绑定 ----------------

  function bindWebview() {
    const wv = els.guest;
    // 新窗口请求一律在当前 webview 打开（避免弹窗）
    wv.addEventListener('new-window', (e) => {
      e.preventDefault();
      const url = e.url;
      if (/^https?:/i.test(url)) wv.loadURL(url);
    });
    // 主 frame 加载失败：明确提示，避免“地址栏没反应”的错觉
    wv.addEventListener('did-fail-load', (e) => {
      if (!e.isMainFrame) return;
      if (e.errorCode === -3) return; // ERR_ABORTED：主动中止（刷新/跳转）不算失败
      if (state.mode !== 'web') return;
      setStageStatus(`页面加载失败：${e.errorDescription || `错误 ${e.errorCode}`}`, false);
      toast(`加载失败：${e.errorDescription || `错误 ${e.errorCode}`}`, 'error', 4200);
    });
    wv.addEventListener('did-start-loading', () => {
      if (state.mode === 'web') setStageStatus('页面加载中…', true);
      syncNavUI();
    });
    wv.addEventListener('did-stop-loading', () => {
      if (state.mode === 'web') setStageStatus('');
      syncNavUI();
    });
    wv.addEventListener('dom-ready', () => {
      syncNavUI();
    });
  }

  function bindEvents() {
    // 窗口控制
    els.btnMin.addEventListener('click', () => api.minimize());
    els.btnMax.addEventListener('click', () => api.toggleMaximize());
    els.btnClose.addEventListener('click', () => api.close());
    api.isMaximized().then((m) => { els.btnMax.title = m ? '还原' : '最大化'; });

    // 模式
    els.modeSeg.forEach((b) => b.addEventListener('click', () => setMode(b.dataset.mode)));

    // 导航
    els.btnBack.addEventListener('click', () => { try { els.guest.goBack(); } catch (_) { /* ignore */ } });
    els.btnForward.addEventListener('click', () => { try { els.guest.goForward(); } catch (_) { /* ignore */ } });
    els.btnRefresh.addEventListener('click', () => { try { els.guest.reload(); } catch (_) { /* ignore */ } });
    els.address.addEventListener('keydown', (e) => { if (e.key === 'Enter') navigate(els.address.value); });

    // 顶栏开关 / 按钮
    els.btnDmToggle.addEventListener('click', toggleDanmaku);
    els.btnFetchTop.addEventListener('click', () => { setSidebar(true); els.fetchVid.focus(); });
    els.btnSidebar.addEventListener('click', () => setSidebar(!state.sideOpen));
    els.btnSideClose.addEventListener('click', () => setSidebar(false));
    els.btnSettings.addEventListener('click', () => setDrawer(!state.settingsOpen));
    els.btnSettingsClose.addEventListener('click', () => setDrawer(false));
    // 控制条上的“设置”快捷入口（观影时随时可调字号 / 数量 / 颜色…）
    els.ctlSettings.addEventListener('click', () => {
      setDrawer(!state.settingsOpen);
      toast(state.settingsOpen ? '弹幕设置已打开' : '', 'info', 900);
    });

    // 打开外挂悬浮窗（兼容模式）
    els.btnOpenLegacy.addEventListener('click', async () => {
      const res = await api.openLegacy();
      if (res && res.ok) toast('外挂悬浮窗已打开：可拖到外部播放器上对齐使用', 'success');
    });

    // 数据卡
    els.btnFeedReload.addEventListener('click', reloadSource);
    els.btnFeedClear.addEventListener('click', () => { clearSource(); toast('弹幕已清空', 'info'); });

    // 控制条
    els.ctlPlay.addEventListener('click', togglePlay);
    els.ctlBack5.addEventListener('click', () => seekBy(-5));
    els.ctlFwd5.addEventListener('click', () => seekBy(5));
    els.ctlMsMinus.addEventListener('click', () => adjustOffset(-100));
    els.ctlMsPlus.addEventListener('click', () => adjustOffset(100));
    els.ctlSeek.addEventListener('input', () => {
      state.seekDragging = true;
      els.ctlTimeCur.textContent = fmtTime(Number(els.ctlSeek.value));
    });
    els.ctlSeek.addEventListener('change', () => {
      const t = Number(els.ctlSeek.value);
      if (state.mode === 'web') api.webControl('seek', t);
      else {
        const v = els.localVideo;
        if (localVideoLoaded) {
          v.currentTime = clamp(t, 0, v.duration || 0);
          if (localEngine) localEngine.seek(v.currentTime);
        }
      }
      state.seekDragging = false;
      setRangeFill(els.ctlSeek);
    });
    els.ctlSeek.addEventListener('pointerup', () => { state.seekDragging = false; setRangeFill(els.ctlSeek); });
    els.ctlFull.addEventListener('click', () => {
      if (state.mode === 'local') {
        if (document.fullscreenElement) document.exitFullscreen();
        else els.localStage.requestFullscreen().catch(() => toast('无法进入全屏', 'warn'));
      }
    });

    // 采集：优先解析输入框（支持粘贴链接），其次当前播放地址
    els.btnScanVid.addEventListener('click', async () => {
      const raw = els.fetchVid.value.trim();
      let r = raw ? await api.extractVid(raw) : null;
      if (!(r && r.ok && r.vid)) {
        const url = guestURL();
        if (url) r = await api.extractVid(url);
      }
      if (r && r.ok && r.vid) {
        els.fetchVid.value = r.vid;
        if (r.title && !els.fetchTitle.value.trim()) els.fetchTitle.value = r.title;
        toast(`识别到 vid：${r.vid}`, 'success');
      } else {
        toast((r && r.error) || '未能识别 vid。可粘贴腾讯视频播放页链接，或手动输入 vid', 'warn', 4600);
      }
    });
    els.fetchVid.addEventListener('input', () => scheduleVidProbe());
    els.fetchVid.addEventListener('paste', () => scheduleVidProbe(0));
    els.btnFetchStart.addEventListener('click', startFetch);
    els.btnFetchCancel.addEventListener('click', async () => {
      await api.fetchCancel();
      els.fetchProgressText.textContent = '正在取消…';
    });
    els.btnShowDir.addEventListener('click', () => api.showCollectedDir());
    els.btnOpenDanmaku.addEventListener('click', async () => {
      const r = await api.openDanmakuDialog();
      if (r && r.path) loadSource(r.path);
    });
    els.btnOpenVideo.addEventListener('click', async () => {
      const r = await api.openVideoDialog();
      if (r && r.path) loadLocalVideo(r.path);
    });
    els.btnEject.addEventListener('click', ejectVideo);

    // 内置搜索
    els.builtinSearch.addEventListener('input', () => renderBuiltin(els.builtinSearch.value));
    els.collectedList.addEventListener('click', (e) => {
      const li = e.target.closest('li[data-path]');
      if (!li) return;
      const title = li.querySelector('.item-text') ? li.querySelector('.item-text').firstChild.textContent : '';
      loadSource(li.dataset.path, String(title || '').split(' (')[0]);
    });
    els.builtinList.addEventListener('click', (e) => {
      const li = e.target.closest('li[data-path]');
      if (!li) return;
      loadSource(li.dataset.path, li.querySelector('.item-text').firstChild.textContent);
    });

    // 本地拖放
    els.localStage.addEventListener('dragover', (e) => {
      e.preventDefault();
      els.localStage.classList.add('drag-over');
    });
    els.localStage.addEventListener('dragleave', () => els.localStage.classList.remove('drag-over'));
    els.localStage.addEventListener('drop', (e) => {
      e.preventDefault();
      els.localStage.classList.remove('drag-over');
      const file = e.dataTransfer.files && e.dataTransfer.files[0];
      if (!file) return;
      const p = api.getPathForFile(file);
      if (VIDEO_EXT.test(file.name)) loadLocalVideo(p);
      else if (DM_EXT.test(file.name)) loadSource(p, file.name.replace(/\.json$/i, ''));
      else toast('仅支持拖入视频文件或弹幕 JSON', 'warn');
    });

    // 双击本地视频进入全屏
    els.localVideo.addEventListener('dblclick', () => {
      if (document.fullscreenElement) document.exitFullscreen();
      else els.localStage.requestFullscreen().catch(() => {});
    });

    // 单击画面：播放 / 暂停；空态点击：打开文件选择
    els.localVideo.addEventListener('click', () => {
      if (!localVideoLoaded) return;
      const vv = els.localVideo;
      if (vv.paused || vv.ended) vv.play().catch(() => {});
      else vv.pause();
    });
    els.localDrop.addEventListener('click', () => {
      if (!localVideoLoaded) els.btnOpenVideo.click();
    });

    // 本地视频事件
    const v = els.localVideo;
    v.addEventListener('loadedmetadata', syncLocalCanvas);
    v.addEventListener('play', () => {
      if (localEngine && localEngine.clockSource) localEngine.play();
      updateCtlFromSource();
    });
    v.addEventListener('pause', () => { updateCtlFromSource(); });
    v.addEventListener('seeked', () => {
      if (localEngine) localEngine.seek(v.currentTime);
      updateCtlFromSource();
    });
    v.addEventListener('timeupdate', () => { if (state.mode === 'local') updateCtlFromSource(); });
    v.addEventListener('durationchange', syncLocalCanvas);
    v.addEventListener('resize', syncLocalCanvas);

    // 舞台尺寸变化 → 重算本地弹幕视口
    if (window.ResizeObserver) {
      new ResizeObserver(() => syncLocalCanvas()).observe(els.localStage);
    } else {
      window.addEventListener('resize', syncLocalCanvas);
    }
    // 本地弹幕时钟
    if (window.danmaku && !localEngine) {
      const clock = {
        isPlaying: () => { const x = els.localVideo; return !!(localVideoLoaded && x && !x.paused && !x.ended); },
        getTime: () => (localVideoLoaded ? els.localVideo.currentTime : 0)
      };
      localEngine = new DanmakuEngine(els.localCanvas, { autoResize: false });
      localEngine.setParams({
        fontSize: state.settings.fontSize,
        speed: state.settings.speed,
        opacity: state.settings.opacity,
        trackCount: state.settings.trackCount,
        density: state.settings.density,
        colorMode: state.settings.colorMode,
        maxActive: state.settings.maxActive
      });
      localEngine.setOffset(state.settings.offsetMs);
      localEngine.setClockSource(clock);
      syncLocalCanvas();
    }
  }

  // ---------------- 启动 ----------------

  async function init() {
    // 加载设置
    const st = await api.loadSettings();
    state.settings = st || {};
    initSettingsUI();
    syncOffsetChip();

    bindEvents();
    bindWebview();
    bindIpc();

    // 侧栏默认展开
    setSidebar(true);

    // 加载两个数据列表
    refreshBuiltin();
    refreshCollected();

    // 打开起始页
    const home = (state.settings && state.settings.homeUrl) || 'https://dmxq23.com/';
    try {
      // 直接 loadURL，避免先赋值 src 再 loadURL 产生的重复导航竞态
      els.guest.loadURL(home);
    } catch (_) { /* ignore */ }

    // 定期刷新本地模式画布视口（极端布局变化兜底）
    setInterval(syncLocalCanvas, 800);
    // 键盘辅助：控制条空间不足时的提示
    updateCtl(false, 0, 0);
  }

  window.addEventListener('DOMContentLoaded', () => {
    init().catch((err) => console.error('[app] init 失败:', err));
  });
})();
