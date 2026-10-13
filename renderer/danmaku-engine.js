/**
 * DanmakuEngine - Canvas 弹幕渲染引擎
 *
 * 支持三种弹幕类型：
 *  - scroll  滚动弹幕（右 → 左，匀速）
 *  - top     顶部弹幕（顶部居中，停留后淡出）
 *  - bottom  底部弹幕（底部居中，停留后淡出）
 *
 * 特性：
 *  - 轨道分配与防追尾
 *  - 屏幕弹幕总数上限 + 密度概率双重控制（防止过于密集）
 *  - 位图缓存渲染：弹幕文字离屏预绘制（描边 + 填充各一次），
 *    运行时逐帧 drawImage 贴图，避免每帧重复绘制文字，显著提升流畅度
 *  - 字号随窗口宽度等比缩放：窗口调整大小时弹幕同步变化
 *  - 对象池复用、离屏回收
 *  - 暂停时冻结渲染循环，节省 CPU
 */
class DanmakuEngine {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {object} [opts]
   * @param {boolean} [opts.autoResize=true] 监听 window resize（legacy 悬浮窗）。外部模式传 false
   * @param {number}   [opts.width]          初始视口宽（CSS px）
   * @param {number}   [opts.height]         初始视口高（CSS px）
   */
  constructor(canvas, opts = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.dpr = window.devicePixelRatio || 1;
    this._autoResize = opts.autoResize !== false;
    this._onWinResize = null;

    this.width = 0;
    this.height = 0;
    this.baseWidth = 0; // 字号缩放的基准宽度（首次铺满屏幕时记录）

    // ---- 数据 ----
    this.data = [];       // 按 time 升序排序的弹幕
    this.pointer = 0;     // 指向 data 中第一个 time >= 有效时间的弹幕

    // ---- 时间轴 ----
    this.currentTime = 0;   // 弹幕时钟（秒）
    this.offsetMs = 0;      // 偏移校准（毫秒，负=弹幕提前出现）
    this.playing = false;
    this.lastTs = 0;
    this.clockSource = null; // 外部时钟源 { isPlaying(), getTime() }，绑定 video 等真实时间源

    // ---- 参数 ----
    this.params = {
      fontSize: 26,
      speed: 1.0,
      opacity: 0.9,
      trackCount: 5,
      density: 0.65,
      colorMode: 'original',  // original | white | vibrant
      maxActive: 10          // 同屏弹幕数量上限
    };

    // ---- 运行状态 ----
    this.scrollTracks = [];  // 每轨道最后一条弹幕的右边缘 x（防追尾用）
    this.topSlots = [];      // 顶部轨道槽（null=空闲）
    this.bottomSlots = [];   // 底部轨道槽
    this.active = [];        // 屏幕上的活动弹幕
    this.pool = [];          // 对象池
    this._lastScrollTrack = -1;

    // ---- 位图缓存 ----
    this._bitmapCache = new Map();
    this._bitmapCap = 300;   // 位图缓存上限：超出后按 LRU 逐出最久未用项（避免整体清空引起的绘制抖动）
    this._measureCtx = null; // 共享文本测量上下文（避免每条新弹幕临时创建 canvas）

    this.raf = 0;
    this._resizeRaf = 0;

    // 初始视口：外部模式由调用方提供宽高；legacy 悬浮窗读取 window 尺寸
    if (opts.width && opts.height) this.resize(opts.width, opts.height);
    else if (this._autoResize) this.resize();
    // 窗口变化（调整大小）时合并到下一帧统一处理，避免高频 resize 抖动
    if (this._autoResize) {
      this._onWinResize = () => {
        if (this._resizeRaf) return;
        this._resizeRaf = requestAnimationFrame(() => {
          this._resizeRaf = 0;
          this.resize();
        });
      };
      window.addEventListener('resize', this._onWinResize);
    }
  }

  /**
   * 释放引擎：停止渲染循环并解除 window 监听。
   * 页面桥 / 播放器卸载时调用，避免悬挂的 rAF 与监听器。
   */
  destroy() {
    this.pause();
    if (this._onWinResize) {
      window.removeEventListener('resize', this._onWinResize);
      this._onWinResize = null;
    }
    if (this._bitmapCache) this._bitmapCache.clear();
    this._measureCtx = null;
  }

  // ---------------- 尺寸 ----------------

  /**
   * 调整渲染视口尺寸。外部模式可传具体宽高（CSS px），
   * 不传时回退读取 window（legacy 悬浮窗行为）。
   */
  resize(overrideW, overrideH) {
    const w = Number.isFinite(overrideW) ? Math.round(overrideW) : window.innerWidth;
    const h = Number.isFinite(overrideH) ? Math.round(overrideH) : window.innerHeight;
    if (!w || !h) return;
    if (w === this.width && h === this.height) return;
    if (!this.baseWidth) this.baseWidth = w;
    this.width = w;
    this.height = h;
    this.canvas.width = Math.round(w * this.dpr);
    this.canvas.height = Math.round(h * this.dpr);
    this.canvas.style.width = `${w}px`;
    this.canvas.style.height = `${h}px`;
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    // 窗口变化后重置轨道状态，避免轨道数据错位
    this._resetTracks();
    // 让屏幕上已有弹幕按新字号 / 新尺寸重新排版（字号随窗口缩放）
    this._reflowActive();
  }

  /** 外部视口模式：显式指定弹幕区域宽高（CSS px），等价 resize(w, h) */
  setViewport(w, h) {
    this.resize(w, h);
  }

  getViewport() {
    return { width: this.width, height: this.height };
  }

  // ---------------- 数据 ----------------

  setData(list) {
    this.data = Array.isArray(list) ? list.slice().sort((a, b) => a.time - b.time) : [];
    this.pointer = 0;
    this._clearActive();
    this._resetTracks();
  }

  // ---------------- 时间轴控制 ----------------

  play() {
    // 已在渲染循环中则忽略（防重复开启）；但若 playing 已为 true 而 rAF 尚未启动
    // （典型场景：setClockSource 绑定到正在播放的时钟源），需要立即补启循环。
    if (this.playing && this.raf) return;
    this.playing = true;
    this.lastTs = performance.now();
    if (!this.raf) this._loop(this.lastTs);
  }

  pause() {
    if (!this.playing) return;
    this.playing = false;
    if (this.raf) {
      cancelAnimationFrame(this.raf);
      this.raf = 0;
    }
  }

  togglePlay() {
    this.playing ? this.pause() : this.play();
  }

  seek(time) {
    this.currentTime = Math.max(0, Number(time) || 0);
    this._seekPointer(this._effectiveTime());
  }

  /**
   * 将发射指针定位到第一个 time >= target 的弹幕，并清屏复位轨道。
   * 外部时钟模式下发生大幅时间跳变（拖动进度等）时由内部兜底调用。
   */
  _seekPointer(target) {
    let lo = 0;
    let hi = this.data.length - 1;
    let idx = this.data.length;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (this.data[mid].time >= target) {
        idx = mid;
        hi = mid - 1;
      } else {
        lo = mid + 1;
      }
    }
    this.pointer = idx;
    this._clearActive();
    this._resetTracks();
  }

  /**
   * 绑定外部时钟源（{ isPlaying():boolean, getTime():秒 }）。
   * 绑定后弹幕时间轴完全跟随外部源（如 video 的 currentTime），
   * 播放 / 暂停 / 拖动均无需手动同步；传 null 恢复自走时钟。
   */
  setClockSource(source) {
    this.clockSource = source || null;
    if (!this.clockSource) {
      this.pause();
      return;
    }
    this.playing = Boolean(this.clockSource.isPlaying());
    if (this.playing) this.play();
    else this.pause();
  }

  getTime() {
    return this.currentTime;
  }

  setOffset(ms) {
    this.offsetMs = Number(ms) || 0;
    // 偏移变化会影响发射窗口，重新定位指针
    this.seek(this.currentTime);
  }

  getEffectiveTime() {
    return this._effectiveTime();
  }

  // ---------------- 参数 ----------------

  setParams(patch) {
    const fontChanged = 'fontSize' in patch;
    Object.assign(this.params, patch);
    this._resetTracks();
    // 字号设置变化时，重排屏幕上已有弹幕
    if (fontChanged) this._reflowActive();
  }

  getParams() {
    return { ...this.params };
  }

  // ---------------- 内部逻辑 ----------------

  _effectiveTime() {
    return this.currentTime - this.offsetMs / 1000;
  }

  /** 当前有效字号：以 baseWidth（首次铺满屏幕宽度）为基准，随窗口宽度等比缩放 */
  _fontSize() {
    if (!this.baseWidth) this.baseWidth = this.width;
    const ratio = this.width / this.baseWidth;
    return Math.max(12, Math.min(72, Math.round(this.params.fontSize * ratio)));
  }

  _loop(ts) {
    if (!this.playing) return;
    // 限制单帧步进，避免窗口切回 / 掉帧时弹幕瞬间涌出
    let dt = (ts - this.lastTs) / 1000;
    if (dt > 0.5) dt = 0.5;
    if (dt < 0) dt = 0;
    this.lastTs = ts;

    if (this.clockSource) {
      // ---- 外部时钟模式：时间完全跟随外部源，play/pause 亦由源决定 ----
      this.playing = Boolean(this.clockSource.isPlaying());
      if (!this.playing) return; // 源暂停：冻结循环，等外部再次 play() 唤醒
      const ext = Number(this.clockSource.getTime()) || 0;
      const jump = Math.abs(ext - this.currentTime);
      this.currentTime = ext;
      // 兜底：拖动/换集造成的大幅跳变（正常 seek 由外部显式 seek() 处理）
      if (jump > 0.9 && this.data.length) this._seekPointer(this._effectiveTime());
      this._spawn();
      this._update(dt);
      this._render();
      this.raf = requestAnimationFrame((t) => this._loop(t));
      return;
    }

    // ---- 自走时钟模式（legacy 悬浮窗 / 无视频兜底） ----
    this.currentTime += dt;

    this._spawn();
    this._update(dt);
    this._render();

    this.raf = requestAnimationFrame((t) => this._loop(t));
  }

  /** 发射到期弹幕（密度概率 + 屏幕数量上限双重控制） */
  _spawn() {
    const eff = this._effectiveTime();
    const maxPerFrame = 6; // 每帧最多新发条数（含位图预生成，防止单帧尖峰）
    const maxActive = this._maxActive();
    let spawned = 0;
    // 到期弹幕一律“消费掉”（发射或丢弃），指针持续前进：
    // 避免屏幕满 / 单帧限额时指针停滞，导致掉帧恢复后过期弹幕集中涌出（二次卡顿与画面时间后滞）
    while (this.pointer < this.data.length && this.data[this.pointer].time <= eff) {
      const dm = this.data[this.pointer];
      this.pointer++;
      if (Math.random() > this.params.density) continue;  // 密度概率丢弃
      if (this.active.length >= maxActive) continue;      // 屏幕已满：丢弃，不积压
      if (this._spawnOne(dm)) {
        spawned++;
        if (spawned >= maxPerFrame) break;
      }
    }
  }

  /** 屏幕同时可见弹幕上限：优先使用用户设置的 maxActive，缺失时回退旧公式 */
  _maxActive() {
    const limit = Number(this.params.maxActive);
    if (Number.isFinite(limit) && limit >= 1) return Math.round(limit);
    const scrollCap = Math.round(this.params.trackCount * 2.5);
    const fixedCap = this.topSlots.length + this.bottomSlots.length;
    const base = scrollCap + fixedCap;
    // density 越低，上限越保守；保底 8 条保证画面不空
    return Math.max(8, Math.round(base * (0.5 + 0.5 * this.params.density)));
  }

  _spawnOne(dm) {
    const color = this._resolveColor(dm.color);
    if (dm.type === 'top') return this._spawnFixed(dm, 'top', color);
    if (dm.type === 'bottom') return this._spawnFixed(dm, 'bottom', color);
    return this._spawnScroll(dm, color);
  }

  _resolveColor(original) {
    const mode = this.params.colorMode;
    if (mode === 'white') return '#FFFFFF';
    if (mode === 'vibrant') {
      const palette = ['#FF5C5C', '#FFB400', '#00D68F', '#00AEEC', '#FF7EB3', '#B388FF'];
      return palette[(Math.random() * palette.length) | 0];
    }
    return original || '#FFFFFF';
  }

  /** 滚动弹幕：分配轨道，防追尾 */
  _spawnScroll(dm, color) {
    const fontSize = this._fontSize();
    const bmp = this._getBitmap(dm.text, color, fontSize);
    const textWidth = bmp.textW;
    const trackH = fontSize * 1.5;
    const usableH = this.height * 0.82; // 底部预留控制条区域
    const maxTracks = Math.max(1, Math.floor(usableH / trackH));
    const trackCount = Math.min(this.params.trackCount, maxTracks);

    // 轮询寻找安全轨道
    const gap = 24;
    for (let i = 0; i < trackCount; i++) {
      const track = (this._lastScrollTrack + 1 + i) % trackCount;
      const tail = this.scrollTracks[track];
      if (tail === undefined || tail < this.width - textWidth - gap) {
        this._lastScrollTrack = track;
        const dmObj = this._acquire();
        const y = trackH * (track + 1) - fontSize * 0.35;
        Object.assign(dmObj, {
          text: dm.text,
          color,
          type: 'scroll',
          x: this.width + 4,
          y,
          width: textWidth,
          fontSize,
          track,
          bmp,
          birth: this.currentTime,
          fade: 1
        });
        this.scrollTracks[track] = this.width + 4;
        this.active.push(dmObj);
        return true;
      }
    }
    return false; // 轨道全满，丢弃
  }

  /** 顶部 / 底部弹幕 */
  _spawnFixed(dm, type, color) {
    const fontSize = this._fontSize();
    const bmp = this._getBitmap(dm.text, color, fontSize);
    const textWidth = bmp.textW;
    const slots = type === 'top' ? this.topSlots : this.bottomSlots;
    const trackH = fontSize * 1.6;

    for (let i = 0; i < slots.length; i++) {
      if (slots[i] === null) {
        slots[i] = 0; // 占位
        const dmObj = this._acquire();
        const y = type === 'top'
          ? trackH * (i + 1) - fontSize * 0.35 + trackH * 0.15
          : this.height - trackH * (slots.length - i) - fontSize * 0.1;
        Object.assign(dmObj, {
          text: dm.text,
          color,
          type,
          x: (this.width - textWidth) / 2,
          y,
          width: textWidth,
          fontSize,
          birth: this.currentTime,
          duration: 4.5,
          slot: i,
          bmp,
          fade: 1
        });
        this.active.push(dmObj);
        return true;
      }
    }
    return false;
  }

  /** 更新活动弹幕（移动 / 淡出 / 回收） */
  _update(dt) {
    const t = this.currentTime;
    for (let i = this.active.length - 1; i >= 0; i--) {
      const dm = this.active[i];
      if (dm.type === 'scroll') {
        const px = (this.width + dm.width + 8) / (7 / this.params.speed);
        dm.x -= px * dt;
        // 同步更新防追尾记录（轨道尾部位置 = 该弹幕右边缘）
        if (dm.track != null) this.scrollTracks[dm.track] = dm.x + dm.width;
        if (dm.x + dm.width < -4) {
          this.active.splice(i, 1);
          this._release(dm);
        }
      } else {
        const age = t - dm.birth;
        if (age > dm.duration) {
          this.active.splice(i, 1);
          if (dm.slot != null) {
            if (dm.type === 'top') this.topSlots[dm.slot] = null;
            else this.bottomSlots[dm.slot] = null;
          }
          this._release(dm);
        } else if (age > dm.duration - 1) {
          dm.fade = dm.duration - age; // 最后 1 秒淡出
        } else {
          dm.fade = 1;
        }
      }
    }
  }

  /** 渲染一帧（位图贴图，性能开销小） */
  _render() {
    const ctx = this.ctx;
    ctx.clearRect(0, 0, this.width, this.height);
    if (!this.active.length) return;

    ctx.save();
    ctx.globalAlpha = this.params.opacity;
    let curFade = -1;
    for (const dm of this.active) {
      const bmp = dm.bmp || (dm.bmp = this._getBitmap(dm.text, dm.color, dm.fontSize));
      // 淡出系数相同（多为 1）时复用 globalAlpha，减少状态切换
      const fade = dm.fade ?? 1;
      if (fade !== curFade) {
        ctx.globalAlpha = this.params.opacity * fade;
        curFade = fade;
      }
      // 文字（含描边）已在位图中一次性绘制，这里只做贴图
      ctx.drawImage(bmp.canvas, dm.x, dm.y - bmp.offsetY, bmp.cssW, bmp.cssH);
    }
    ctx.restore();
  }

  /** 弹幕文字位图缓存：key = 字号|颜色|文本 */
  _getBitmap(text, color, fontSize) {
    const key = `${fontSize}|${color}|${text}`;
    const hit = this._bitmapCache.get(key);
    if (hit) {
      // 命中即刷新 LRU 位置（最近使用放在 Map 末尾）
      this._bitmapCache.delete(key);
      this._bitmapCache.set(key, hit);
      return hit;
    }

    const font = `${fontSize}px "Microsoft YaHei", "PingFang SC", "Segoe UI", sans-serif`;
    if (!this._measureCtx) this._measureCtx = document.createElement('canvas').getContext('2d');
    this._measureCtx.font = font;
    const textW = this._measureCtx.measureText(text).width;

    const pad = Math.ceil(fontSize * 0.4);   // 左右留白，容纳描边
    const cssW = Math.ceil(textW) + pad * 2;
    const cssH = Math.ceil(fontSize * 1.6);
    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(cssW * this.dpr);   // 按 DPR 高分辨率绘制，贴图时清晰
    canvas.height = Math.ceil(cssH * this.dpr);

    const g = canvas.getContext('2d');
    g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    g.font = font;
    g.textBaseline = 'alphabetic';
    g.lineJoin = 'round';
    g.lineCap = 'round';
    g.strokeStyle = 'rgba(0, 0, 0, 0.85)';
    g.lineWidth = Math.max(2.5, fontSize / 7);
    g.strokeText(text, pad, cssH - fontSize * 0.35);
    g.fillStyle = color;
    g.fillText(text, pad, cssH - fontSize * 0.35);

    const bmp = { canvas, cssW, cssH, textW, offsetY: cssH - fontSize * 0.35 };
    if (this._bitmapCache.size >= this._bitmapCap) {
      // LRU 逐出最久未用项（Map 首项）而非整体清空，避免周期性的整体重绘 / GC 尖峰
      const oldestKey = this._bitmapCache.keys().next().value;
      if (oldestKey !== undefined) this._bitmapCache.delete(oldestKey);
    }
    this._bitmapCache.set(key, bmp);
    return bmp;
  }

  /** 窗口尺寸 / 字号变化后，按新字号与新尺寸重排屏幕上已有弹幕 */
  _reflowActive() {
    if (!this.active.length) return;
    const fontSize = this._fontSize();
    const scrollTrackH = fontSize * 1.5;
    const fixedTrackH = fontSize * 1.6;
    const fixedSlots = this.topSlots.length;

    for (let i = this.active.length - 1; i >= 0; i--) {
      const dm = this.active[i];
      dm.fontSize = fontSize;
      dm.bmp = this._getBitmap(dm.text, dm.color, fontSize);
      dm.width = dm.bmp.textW;

      if (dm.type === 'scroll') {
        // 窗口缩小后轨道数可能减少，超出新上限的弹幕直接回收
        if (dm.track == null || dm.track >= this.scrollTracks.length) {
          this.active.splice(i, 1);
          this._release(dm);
          continue;
        }
        dm.y = scrollTrackH * (dm.track + 1) - fontSize * 0.35;
        this.scrollTracks[dm.track] = dm.x + dm.width;
      } else {
        dm.x = (this.width - dm.width) / 2;
        if (dm.type === 'top') {
          dm.y = fixedTrackH * (dm.slot + 1) - fontSize * 0.35 + fixedTrackH * 0.15;
        } else {
          dm.y = this.height - fixedTrackH * (fixedSlots - dm.slot) - fontSize * 0.1;
        }
      }
    }
  }

  /** 清空屏幕上所有弹幕（回收至池） */
  _clearActive() {
    for (const dm of this.active) this._release(dm);
    this.active.length = 0;
  }

  _resetTracks() {
    this.scrollTracks = [];
    this.topSlots = [];
    this.bottomSlots = [];
    const trackCount = Math.max(1, Math.min(this.params.trackCount, 10));
    // 顶部 / 底部固定弹幕槽位与滚动轨道按比例共享 trackCount
    // （此前固定槽位数量等于轨道数，滚动+顶部+底部最多 3×trackCount 条，极易铺满全屏）
    const fixedCount = Math.max(1, Math.min(5, Math.round(trackCount / 2)));
    this._lastScrollTrack = -1;
    for (let i = 0; i < trackCount; i++) this.scrollTracks.push(-Infinity);
    for (let i = 0; i < fixedCount; i++) {
      this.topSlots.push(null);
      this.bottomSlots.push(null);
    }
  }

  // ---------------- 对象池 ----------------

  _acquire() {
    if (this.pool.length) return this.pool.pop();
    return {
      text: '', color: '#FFFFFF', type: 'scroll',
      x: 0, y: 0, width: 0, fontSize: 0,
      track: null, slot: null, birth: 0, duration: 0, fade: 1, bmp: null
    };
  }

  _release(dm) {
    dm.text = '';
    dm.color = '#FFFFFF';
    dm.type = 'scroll';
    dm.x = 0;
    dm.y = 0;
    dm.width = 0;
    dm.fontSize = 0;
    dm.track = null;
    dm.slot = null;
    dm.birth = 0;
    dm.duration = 0;
    dm.fade = 1;
    dm.bmp = null;
    if (this.pool.length < 200) this.pool.push(dm);
  }
}
