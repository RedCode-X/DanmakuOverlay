/* page-bridge.js — 注入 <webview> guest 页面的弹幕桥脚本
 *
 * 本文件以“文本”形式被 lib/bridge-injector.js 读取，注入执行前会先把
 * renderer/danmaku-engine.js 的源码拼在本文件之前，二者处于同一 IIFE 作用域，
 * 因此本文件可直接引用 `DanmakuEngine`，且不会污染页面全局。
 *
 * 协议（由主进程通过 executeJavaScript 调用）：
 *   window.__dmBridgeV1 = {
 *     version, getState(), attach(cfg), control(cmd, arg), deactivate()
 *   }
 *
 * 职责：
 *   - 探测并持续跟随 frame 内的主 <video>
 *   - 创建固定定位、pointer-events:none 的弹幕 Canvas，覆盖在视频可视区域上
 *   - 弹幕时钟绑定 video 真实时间轴（播放 / 暂停 / 拖动 / 换集自动跟随）
 *   - 经 dm-feed:// 自定义协议拉取弹幕数据
 */
(() => {
  'use strict';
  if (window.__dmBridgeV1) return; // 幂等：同一 frame 只挂载一次

  const VERSION = 1;
  const FEED_BASE = 'dm-feed://feed/';
  const OVERLAY_ID = '__dm_overlay_root';
  const MIN_AREA = 120 * 120; // 低于该像素面积的 video 视为装饰元素

  const DEFAULT_SETTINGS = {
    fontSize: 26,
    speed: 1.0,
    opacity: 0.9,
    trackCount: 5,
    density: 0.65,
    colorMode: 'original',
    offsetMs: 0,
    maxActive: 10
  };

  // 运行期状态（全部收在闭包内，不暴露到页面）
  let overlayEl = null;
  let canvasEl = null;
  let engine = null;
  let videoEl = null;
  let videoSrcSig = null;   // 用于换源检测
  let settings = { ...DEFAULT_SETTINGS };
  let visible = true;
  let disposed = false;
  let rafId = 0;
  let lastW = 0;
  let lastH = 0;
  let lastLeft = 0;
  let lastTop = 0;
  let stateRect = { w: 0, h: 0 };  // 视频可视区尺寸缓存（ticker 更新，供 getState 复用）
  let lastRecheck = 0;             // 距上次重选播放器的时间戳（ms）

  // ---------------- 工具 ----------------

  function clampRect(rect) {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const x = Math.max(0, rect.left);
    const y = Math.max(0, rect.top);
    const x2 = Math.min(vw, rect.right);
    const y2 = Math.min(vh, rect.bottom);
    return { left: x, top: y, width: Math.max(0, x2 - x), height: Math.max(0, y2 - y) };
  }

  /** 选取本 frame 内“最像主播放器”的 video */
  function pickVideo() {
    if (document.visibilityState === 'hidden') return null;
    const list = document.querySelectorAll('video');
    if (!list.length) return null;
    let best = null;
    let bestScore = -1;
    for (const v of list) {
      // 跳过不可见 / 无数据 / 尺寸过小的
      if (v.readyState === 0 && !v.src && !v.currentSrc) continue;
      const rect = v.getBoundingClientRect();
      const area = rect.width * rect.height;
      if (!rect.width || !rect.height || area < MIN_AREA) continue;
      // 偏好在播放中的；其次面积大的
      let score = area;
      if (!v.paused && !v.ended) score *= 8;
      if (v.dataset.__dmCandidate === undefined) {
        if (v.style.opacity === '0' || v.hasAttribute('hidden')) continue;
      }
      if (score > bestScore) {
        bestScore = score;
        best = v;
      }
    }
    return best;
  }

  function srcSignature(v) {
    return `${v.src || ''}|${v.currentSrc || ''}`;
  }

  function normalize(list) {
    if (!Array.isArray(list)) return [];
    return list
      .map((d) => {
        if (!d || typeof d !== 'object') return null;
        const type = ['scroll', 'top', 'bottom'].includes(d.type) ? d.type : 'scroll';
        const time = Number(d.time);
        if (!Number.isFinite(time) || time < 0) return null;
        return {
          time,
          type,
          text: String(d.text || '').trim(),
          color: typeof d.color === 'string' ? d.color : undefined
        };
      })
      .filter((d) => d && d.text.length > 0);
  }

  // ---------------- 弹幕渲染挂载 ----------------

  function createOverlay() {
    if (overlayEl) return;
    overlayEl = document.createElement('div');
    overlayEl.id = OVERLAY_ID;
    overlayEl.style.cssText = [
      'position:fixed', 'left:0', 'top:0', 'width:0', 'height:0',
      'pointer-events:none', 'z-index:2147483646',
      'transform:translateZ(0)', 'contain:strict'
    ].join(';') + ';';
    canvasEl = document.createElement('canvas');
    canvasEl.style.cssText = 'position:fixed;left:0;top:0;pointer-events:none;';
    overlayEl.appendChild(canvasEl);
    (document.body || document.documentElement).appendChild(overlayEl);
  }

  function teardownOverlay() {
    disposed = true;
    if (rafId) cancelAnimationFrame(rafId);
    rafId = 0;
    if (engine) {
      engine.destroy();
      engine = null;
    }
    if (overlayEl) {
      overlayEl.remove();
      overlayEl = null;
      canvasEl = null;
    }
    videoEl = null;
    lastW = 0; lastH = 0; lastLeft = 0; lastTop = 0;
    stateRect = { w: 0, h: 0 };
  }

  function ensureEngine() {
    if (engine) return true;
    const v = videoEl || pickVideo();
    if (!v) return false;
    videoEl = v;
    createOverlay();
    engine = new DanmakuEngine(canvasEl, { autoResize: false });
    engine.setParams({ ...settings });
    engine.setData([]);
    engine.setVisible && engine.setVisible(visible);
    bindVideoEvents(v);
    startTicker();
    syncFrame();
    if (!v.paused && !v.ended) engine.setClockSource(clockSource());
    return true;
  }

  function clockSource() {
    return {
      isPlaying: () => {
        const v = videoEl;
        return !!(v && !v.paused && !v.ended && !v.seeking && v.readyState > 0);
      },
      getTime: () => (videoEl ? videoEl.currentTime : 0)
    };
  }

  function bindVideoEvents(v) {
    v.addEventListener('seeked', onSeeked, true);
    v.addEventListener('seeking', onSeeked, true); // 拖动过程即时清屏，避免残留
    v.addEventListener('play', onSourcePlay, true);
    v.addEventListener('durationchange', onMeta, true);
  }

  function onSeeked() {
    if (!engine || !videoEl) return;
    // 视频跳转：弹幕指针与屏幕同步复位（清屏防残留）
    engine.seek(videoEl.currentTime);
  }

  function onSourcePlay() {
    if (!engine || !videoEl) return;
    if (!videoEl.paused && !videoEl.ended) engine.play();
  }

  function onMeta() {
    if (engine && videoEl) engine.seek(videoEl.currentTime);
  }

  /** 同步定位循环：跟随视频可视区域 + 唤醒引擎 */
  function startTicker() {
    const tick = () => {
      if (disposed || !engine) return;
      rafId = requestAnimationFrame(tick);
      syncFrame();
      const v = videoEl;
      if (!v) return;
      const playing = !v.paused && !v.ended && v.readyState > 0;
      if (playing && !engine.playing) engine.play();
      // 换源检测（video.src 变化），标记以便主进程轮询感知
      const sig = srcSignature(v);
      if (sig !== videoSrcSig) {
        videoSrcSig = sig;
      }
    };
    rafId = requestAnimationFrame(tick);
  }

  /** 将 canvas 同步到视频在视口中的可视矩形（自动跟随滚动 / 全屏伪全屏 / 尺寸变化） */
  function syncFrame() {
    const v = videoEl;
    if (!v || !canvasEl || !overlayEl) return;
    const raw = v.getBoundingClientRect();
    const r = clampRect(raw);
    const w = Math.round(r.width);
    const h = Math.round(r.height);
    const left = Math.round(r.left);
    const top = Math.round(r.top);
    if (w > 0 && h > 0) {
      stateRect = { w, h }; // 供 getState 复用，避免主进程轮询时反复读布局
      // 视频静止时不做任何样式写入：每帧重复写 style 会持续触发样式重算，是卡顿源之一
      if (left === lastLeft && top === lastTop && w === lastW && h === lastH) return;
      overlayEl.style.width = `${w}px`;
      overlayEl.style.height = `${h}px`;
      overlayEl.style.left = `${left}px`;
      overlayEl.style.top = `${top}px`;
      canvasEl.style.width = `${w}px`;
      canvasEl.style.height = `${h}px`;
      lastLeft = left;
      lastTop = top;
      if ((w !== lastW || h !== lastH) && engine) {
        lastW = w;
        lastH = h;
        engine.setViewport(w, h);
      }
    }
  }

  // ---------------- 数据加载 ----------------

  function loadFromFeed(feedUrl) {
    return fetch(feedUrl, { credentials: 'omit' })
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      })
      .then((raw) => {
        const list = normalize(raw);
        if (!engine) ensureEngine();
        if (!engine) return { ok: false, error: 'no video' };
        engine.setData(list);
        engine.setOffset(settings.offsetMs);
        engine.seek(videoEl ? videoEl.currentTime : 0);
        const v = videoEl;
        if (v && !v.paused && !v.ended && !engine.playing) engine.play();
        return { ok: true, count: list.length };
      })
      .catch((err) => ({ ok: false, error: String(err && err.message || err) }));
  }

  // ---------------- 对外 API ----------------

  function getState() {
    const now = performance.now();
    let v = videoEl;
    if (v && (!v.isConnected || v.ownerDocument !== document)) v = null;
    // 周期性重选（约 2.5s）：应对页面动态新增 / 更换播放器节点；多数帧直接复用缓存
    if (!v || now - lastRecheck > 2500) {
      lastRecheck = now;
      const picked = pickVideo();
      if (picked) {
        if (picked !== v) bindVideoEvents(picked); // 换播放器节点时补挂事件
        v = picked;
      }
    }
    if (!v) return { hasVideo: false };
    videoEl = v;
    const size = (stateRect.w > 0 && stateRect.h > 0)
      ? stateRect                    // ticker 已缓存的可视区尺寸
      : readVideoSize(v);            // overlay 尚未定位时的兜底
    return {
      hasVideo: true,
      ready: v.readyState > 0,
      playing: !v.paused && !v.ended,
      paused: v.paused,
      seeking: v.seeking,
      time: v.currentTime,
      duration: Number.isFinite(v.duration) ? v.duration : 0,
      rate: v.playbackRate,
      muted: v.muted,
      volume: v.volume,
      w: size.w,
      h: size.h,
      src: v.currentSrc || v.src || '',
      title: String(document.title || '').slice(0, 200)
    };
  }

  function readVideoSize(v) {
    const rect = v.getBoundingClientRect();
    return {
      w: Math.round(Math.min(rect.width, window.innerWidth)),
      h: Math.round(Math.min(rect.height, window.innerHeight))
    };
  }

  function attach(cfg) {
    if (cfg && cfg.settings) settings = { ...DEFAULT_SETTINGS, ...cfg.settings };
    if (!ensureEngine()) return { ok: false, error: 'frame 中未找到视频' };
    if (!videoEl) return { ok: false, error: 'no video' };
    visible = true;
    overlayEl.style.display = '';
    return { ok: true };
  }

  function control(cmd, arg) {
    switch (cmd) {
      case 'play': {
        const v = videoEl;
        if (v && v.paused) v.play().catch(() => {});
        if (engine && v && !v.paused) engine.play();
        return { ok: true };
      }
      case 'pause': {
        const v = videoEl;
        if (v && !v.paused) v.pause();
        if (engine) engine.pause();
        return { ok: true };
      }
      case 'seek': {
        const t = Math.max(0, Number(arg) || 0);
        if (videoEl) {
          try { videoEl.currentTime = t; } catch (_) { /* ignore */ }
        }
        if (engine) engine.seek(t);
        return { ok: true };
      }
      case 'offset': {
        settings.offsetMs = Math.max(-10000, Math.min(10000, Number(arg) || 0));
        if (engine) engine.setOffset(settings.offsetMs);
        return { ok: true };
      }
      case 'applySettings': {
        const patch = arg || {};
        settings = { ...settings, ...patch };
        const p = { ...patch };
        if (p.offsetMs) { p.offsetMs = undefined; }
        if (engine) {
          engine.setParams({
            fontSize: settings.fontSize,
            speed: settings.speed,
            opacity: settings.opacity,
            trackCount: settings.trackCount,
            density: settings.density,
            colorMode: settings.colorMode,
            maxActive: settings.maxActive
          });
          engine.setOffset(settings.offsetMs);
        }
        return { ok: true };
      }
      case 'setData': {
        const feedUrl = arg && (arg.feedUrl || (FEED_BASE + arg.key));
        if (!feedUrl) return { ok: false, error: 'no feedUrl' };
        return loadFromFeed(feedUrl);
      }
      case 'clearData': {
        if (engine) engine.setData([]);
        return { ok: true };
      }
      case 'setVisible': {
        visible = arg !== false;
        if (overlayEl) overlayEl.style.display = visible ? '' : 'none';
        if (!visible && engine) engine.pause();
        return { ok: true };
      }
      default:
        return { ok: false, error: `unknown cmd: ${cmd}` };
    }
  }

  function deactivate() {
    teardownOverlay();
    return { ok: true };
  }

  const api = { version: VERSION, getState, attach, control, deactivate };
  Object.defineProperty(window, '__dmBridgeV1', {
    value: api,
    configurable: true,
    writable: false
  });
})();
