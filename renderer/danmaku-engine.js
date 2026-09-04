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
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.dpr = window.devicePixelRatio || 1;

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

    // ---- 参数 ----
    this.params = {
      fontSize: 26,
      speed: 1.0,
      opacity: 0.9,
      trackCount: 6,
      density: 0.8,
      colorMode: 'original'   // original | white | vibrant
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
    this._bitmapCap = 300;   // 超出后整体清空（弹幕文本不断变化，可接受）

    this.raf = 0;
    this._resizeRaf = 0;

    this.resize();
    // 窗口变化（调整大小）时合并到下一帧统一处理，避免高频 resize 抖动
    window.addEventListener('resize', () => {
      if (this._resizeRaf) return;
      this._resizeRaf = requestAnimationFrame(() => {
        this._resizeRaf = 0;
        this.resize();
      });
    });
  }

  // ---------------- 尺寸 ----------------

  resize() {
    const w = window.innerWidth;
    const h = window.innerHeight;
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

  // ---------------- 数据 ----------------

  setData(list) {
    this.data = Array.isArray(list) ? list.slice().sort((a, b) => a.time - b.time) : [];
    this.pointer = 0;
    this._clearActive();
    this._resetTracks();
  }

  // ---------------- 时间轴控制 ----------------

  play() {
    if (this.playing) return;
    this.playing = true;
    this.lastTs = performance.now();
    this._loop(this.lastTs);
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
    // 定位指针：第一个 time >= 有效时间的弹幕
    const eff = this._effectiveTime();
    let lo = 0;
    let hi = this.data.length - 1;
    let idx = this.data.length;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (this.data[mid].time >= eff) {
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

    this.currentTime += dt;

    this._spawn();
    this._update(dt);
    this._render();

    this.raf = requestAnimationFrame((t) => this._loop(t));
  }

  /** 发射到期弹幕（密度概率 + 屏幕数量上限双重控制） */
  _spawn() {
    const eff = this._effectiveTime();
    const maxPerFrame = 8; // 防瞬时突增
    const maxActive = this._maxActive();
    let spawned = 0;
    while (this.pointer < this.data.length && this.data[this.pointer].time <= eff) {
      const dm = this.data[this.pointer];
      this.pointer++;
      // 密度控制：按 density 概率丢弃
      if (Math.random() > this.params.density) continue;
      if (spawned >= maxPerFrame) break;
      // 屏幕上弹幕已过多时停止发射（后续到期的自动丢弃），保持画面不拥挤
      if (this.active.length >= maxActive) break;
      if (this._spawnOne(dm)) spawned++;
    }
  }

  /** 屏幕同时可见弹幕上限：随轨道数与密度动态变化 */
  _maxActive() {
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
    for (const dm of this.active) {
      const bmp = dm.bmp || (dm.bmp = this._getBitmap(dm.text, dm.color, dm.fontSize));
      ctx.globalAlpha = this.params.opacity * (dm.fade ?? 1);
      // 文字（含描边）已在位图中一次性绘制，这里只做贴图
      ctx.drawImage(bmp.canvas, dm.x, dm.y - bmp.offsetY, bmp.cssW, bmp.cssH);
    }
    ctx.restore();
  }

  /** 弹幕文字位图缓存：key = 字号|颜色|文本 */
  _getBitmap(text, color, fontSize) {
    const key = `${fontSize}|${color}|${text}`;
    const hit = this._bitmapCache.get(key);
    if (hit) return hit;

    const font = `${fontSize}px "Microsoft YaHei", "PingFang SC", "Segoe UI", sans-serif`;
    const probe = document.createElement('canvas').getContext('2d');
    probe.font = font;
    const textW = probe.measureText(text).width;

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
    if (this._bitmapCache.size >= this._bitmapCap) this._bitmapCache.clear();
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
    this._lastScrollTrack = -1;
    for (let i = 0; i < trackCount; i++) {
      this.scrollTracks.push(-Infinity);
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
