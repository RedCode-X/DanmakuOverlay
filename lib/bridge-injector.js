/* bridge-injector.js — 主进程：页面桥注入与调度
 *
 * 职责：
 *   - 监听 <webview> guest（webview 类型 WebContents），向其中每个 http(s) frame
 *     注入 lib/page-bridge.js（前置拼接 renderer/danmaku-engine.js 源码，幂等）
 *   - 周期轮询各 frame 的视频状态，仲裁“当前激活播放帧”
 *   - 向激活帧下发弹幕设置 / 弹幕数据(feed) / 播放控制，向应用层广播视频状态
 *
 * 用法（main.js）：
 *   const bridge = createPageBridgeController({
 *     onState: (st) => ...,            // { found, playing, time, duration, ... }
 *     onVideoChanged: (st) => ...      // 换集/换源（供应用层提示重新选择弹幕数据）
 *   });
 *   bridge.setGuest(guestWebContents);
 *   bridge.applySettings(settings);       // 参数（字号/透明度/...）
 *   bridge.setActiveFeed({ key, feedUrl }); // 下发弹幕数据
 *   bridge.control('play' | 'pause' | 'seek' | 'offset' | 'setVisible', arg);
 *   bridge.dispose();
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ENGINE_FILE = path.join(__dirname, '..', 'renderer', 'danmaku-engine.js');
const BRIDGE_FILE = path.join(__dirname, 'page-bridge.js');

// 视频状态轮询周期。页面内 getState 已做轻量化，但 executeJavaScript 仍会短暂占用
// guest 页面主线程：1000ms 周期在“控制响应”（指令走独立通道，不经轮询）与
// “避免周期性抢占页面线程造成弹幕/视频卡顿”之间更均衡。
const POLL_MS = 1000;

// 探测注入状态 + 拉取状态（同步返回对象，注入器每次以 executeJavaScript 执行）
const PROBE_SRC = `(function () {
  'use strict';
  try {
    var b = window.__dmBridgeV1;
    if (!b || typeof b.getState !== 'function') return { injected: false };
    var st = b.getState() || {};
    st.injected = true;
    return st;
  } catch (e) { return { injected: false, error: String(e && e.message || e) }; }
})()`;

let _sourceCache = null;
function buildBridgeSource() {
  if (_sourceCache) return _sourceCache;
  const engineSrc = fs.readFileSync(ENGINE_FILE, 'utf8');
  const bridgeSrc = fs.readFileSync(BRIDGE_FILE, 'utf8');
  // 同一 IIFE：引擎类与桥逻辑共享作用域，不污染页面全局
  _sourceCache = `(function () {\n'use strict';\n${engineSrc}\n${bridgeSrc}\n})();`;
  return _sourceCache;
}

function collectFrames(frame, out) {
  if (!frame) return out;
  out.push(frame);
  for (const f of frame.frames || []) collectFrames(f, out);
  return out;
}

function frameId(frame) {
  try {
    return frame.frameTreeNodeId != null ? frame.frameTreeNodeId : frame.routingId;
  } catch (_) {
    return 0;
  }
}

class PageBridgeController {
  /**
   * @param {object} handlers
   * @param {(st: object) => void} handlers.onState        视频/弹幕状态（约 600ms）
   * @param {(st: object) => void} handlers.onVideoChanged 检测到换集/换源
   * @param {(...a: any[]) => void} [handlers.debug]       诊断日志（可选，仅状态变化时输出）
   */
  constructor(handlers) {
    this.handlers = handlers || {};
    this.debug = (this.handlers && typeof this.handlers.debug === 'function') ? this.handlers.debug : null;
    this.guest = null;
    this.source = buildBridgeSource();
    this.timer = null;
    this.activeFrame = null;       // 当前激活的 WebFrameMain
    this.activeFrameId = null;
    this.activated = false;        // active frame 是否已 attach 成功
    this.settings = {};
    this.feed = null;              // { key, feedUrl }
    this.lastSig = '';             // 换源检测签名（frameId|src）
    this._busy = false;
    // 诊断：日志节流状态（避免每秒重复刷屏）
    this._dbgSeq = 0;
    this._dbgSeqStr = '';
    this._dbgUninjected = '';      // 当前未能注入成功的 frame 清单摘要
    this._dbgErr = '';             // 上轮错误摘要
  }

  _dbg(...a) {
    if (this.debug) { try { this.debug(...a); } catch (_) { /* ignore */ } }
  }

  /** 绑定 webview guest。替代旧 guest 时自动解绑。 */
  setGuest(guest) {
    if (this.guest === guest) return;
    this.clearState();
    this.guest = guest;
    this.start();
  }

  getGuest() {
    return this.guest;
  }

  clearState() {
    this.activeFrame = null;
    this.activeFrameId = null;
    this.activated = false;
    this.lastSig = '';
  }

  start() {
    this.stop();
    // 首次立即轮询，后续定时
    this.pollOnce();
    this.timer = setInterval(() => this.pollOnce(), POLL_MS);
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  dispose() {
    this.stop();
    this.guest = null;
    this.clearState();
  }

  // ---------------- 对外控制 ----------------

  applySettings(settings) {
    this.settings = { ...(settings || {}) };
    if (this.activated) this._control('applySettings', this.settings);
  }

  /** 下发弹幕数据（feed 为 dm-feed:// 协议 URL 对应的 key） */
  setActiveFeed(feed) {
    this.feed = feed || null;
    this._dbg(`[setActiveFeed] activated=${this.activated} feed=${this.feed ? this.feed.feedUrl : 'null'}`);
    if (this.activated && this.feed) {
      this._control('setData', { feedUrl: this.feed.feedUrl })
        .then((rr) => this._dbg(`[feed] setData 结果: ${JSON.stringify(rr)}`))
        .catch((err) => this._dbg('[feed] setData 异常:', err && err.message || err));
    } else if (this.feed && !this.activated) {
      // 尚未 attach：等在下一轮 poll 完成 attach 后由激活逻辑推送
      this._dbg('[feed] 桥未激活，等待 attach 后推送');
    }
  }

  clearActiveFeed() {
    this.feed = null;
    if (this.activated) this._control('clearData');
  }

  /** 向激活帧的 video 下发控制：play/pause/seek/offset/setVisible/clearData */
  control(cmd, arg) {
    if (this.activated) return this._control(cmd, arg);
    return Promise.resolve({ ok: false, error: 'bridge 未激活' });
  }

  _control(cmd, arg) {
    const frame = this.activeFrame;
    if (!frame) {
      return Promise.resolve({ ok: false, error: 'bridge 未激活' });
    }
    const code = `(function () { try {
      var b = window.__dmBridgeV1;
      if (!b || typeof b.control !== 'function') return { ok: false, error: 'bridge missing' };
      return b.control(${JSON.stringify(cmd)}, ${JSON.stringify(arg === undefined ? null : arg)});
    } catch (e) { return { ok: false, error: String(e && e.message || e) }; } })()`;
    return frame.executeJavaScript(code).catch((err) => ({ ok: false, error: String(err.message || err) }));
  }

  _attachTo(frame) {
    const code = `(function () { try {
      var b = window.__dmBridgeV1;
      if (!b || typeof b.attach !== 'function') return { ok: false, error: 'bridge missing' };
      return b.attach(${JSON.stringify({ settings: this.settings })});
    } catch (e) { return { ok: false, error: String(e && e.message || e) }; } })()`;
    return frame.executeJavaScript(code).catch((err) => ({ ok: false, error: String(err.message || err) }));
  }

  // ---------------- 轮询 ----------------

  async pollOnce() {
    if (this._busy) return;
    const guest = this.guest;
    if (!guest || guest.isDestroyed()) {
      this.clearState();
      return;
    }
    const top = guest.mainFrame;
    if (!top) return;
    this._busy = true;
    try {
      const frames = collectFrames(top, []);
      const candidates = [];
      let httpFrames = 0;
      const uninjected = [];

      for (const frame of frames) {
        let url = '';
        try { url = frame.url || ''; } catch (_) { /* frame 可能已销毁 */ }
        if (!/^https?:/i.test(url)) continue;
        httpFrames++;

        let res = null;
        try { res = await frame.executeJavaScript(PROBE_SRC); } catch (_) { /* 未就绪，跳过 */ }
        if (!res || !res.injected) {
          // 未注入 → 尝试注入（幂等标记由桥自身保证）
          uninjected.push(String(url).slice(0, 80));
          try { await frame.executeJavaScript(this.source); } catch (_) { /* 重试下一轮 */ }
          continue;
        }
        if (res.hasVideo) {
          candidates.push({ frame, st: res });
        }
      }

      // ---- 注入健康摘要（仅变化时输出，避免每轮刷屏）----
      const uniqUninjected = uninjected.join(' | ');
      if (uniqUninjected !== this._dbgUninjected) {
        this._dbgUninjected = uniqUninjected;
        if (uniqUninjected) this._dbg(`[poll] 未注入 frame: ${uniqUninjected}`);
      }
      const seq = `frames=${httpFrames} video=${candidates.length} activated=${this.activated}`;
      if (seq !== this._dbgSeqStr) {
        this._dbgSeqStr = seq;
        this._dbg(`[poll] ${seq}${candidates.length ? ` 候选@${String(candidates[0].st.title || '').slice(0, 30)} t=${candidates[0].st.time}s playing=${candidates[0].st.playing}` : ''}`);
      }

      // ---- 仲裁激活帧 ----
      // 1) 当前激活帧仍有效（有视频）则保持，避免抖动
      // 2) 否则优先“正在播放”的候选，其次可视面积最大的候选
      let active = null;
      if (this.activeFrame) {
        const cur = candidates.find((c) => frameId(c.frame) === this.activeFrameId);
        if (cur) active = cur;
      }
      if (!active) {
        for (const c of candidates) {
          if (c.st.playing) { active = c; break; }
        }
      }
      if (!active && candidates.length) {
        active = candidates.reduce((a, b) =>
          ((b.st.w || 0) * (b.st.h || 0)) > ((a.st.w || 0) * (a.st.h || 0)) ? b : a
        );
      }

      // ---- 激活 / 去激活 ----
      if (active && (!this.activated || frameId(active.frame) !== this.activeFrameId)) {
        // 停用旧帧
        if (this.activated && this.activeFrame) {
          await this._control('deactivate').catch(() => {});
        }
        const r = await this._attachTo(active.frame);
        this.activeFrame = active.frame;
        this.activeFrameId = frameId(active.frame);
        this.activated = r && r.ok;
        this._dbg(`[attach] ${this.activated ? 'OK' : '失败'} → ${String((active.st && active.st.title) || '').slice(0, 40)}${r && r.error ? `  err=${r.error}` : ''}`);
        if (this.activated) {
          // 推送最新设置与待加载数据
          this._control('applySettings', this.settings);
          if (this.feed) {
            this._control('setData', { feedUrl: this.feed.feedUrl })
              .then((rr) => this._dbg(`[feed] setData 结果: ${JSON.stringify(rr)}`))
              .catch((err) => this._dbg('[feed] setData 异常:', err && err.message || err));
          }
        }
      } else if (!active) {
        if (this.activated && this.activeFrame) {
          await this._control('deactivate').catch(() => {});
        }
        this.activated = false;
        this.activeFrame = null;
        this.activeFrameId = null;
        // 无视频：上报 empty 状态
        this._emitState({ found: false });
        this._checkSignature('', {});
        return;
      }

      // ---- 上报状态 + 换源检测 ----
      const st = active ? active.st : { found: false };
      this._emitState(active ? { found: true, ...st } : { found: false });

      const sig = active ? `${this.activeFrameId}|${st.src || ''}` : '';
      this._checkSignature(sig, active ? st : {});
    } catch (err) {
      // 单轮失败不影响后续轮询；记录错误摘要（去抖，避免每轮刷屏）
      const msg = String((err && err.message) || err);
      if (msg !== this._dbgErr) {
        this._dbgErr = msg;
        this._dbg('[poll] 轮询异常:', msg);
      }
    } finally {
      this._busy = false;
    }
  }

  _emitState(st) {
    if (this.handlers.onState) {
      try { this.handlers.onState(st); } catch (_) { /* ignore */ }
    }
  }

  _checkSignature(sig, st) {
    if (sig !== this.lastSig) {
      const prev = this.lastSig;
      this.lastSig = sig;
      // 从“无 → 有”或“源发生变化”视为换片/换集
      if (prev !== '' && st && st.found) {
        if (this.handlers.onVideoChanged) {
          try { this.handlers.onVideoChanged(st); } catch (_) { /* ignore */ }
        }
      }
    }
  }
}

/** 创建控制器并绑定到 app 生命周期（webview 创建即接管） */
function createPageBridgeController(handlers) {
  const controller = new PageBridgeController(handlers);

  const onWebContentsCreated = (_event, contents) => {
    let type = '';
    try { type = contents.getType(); } catch (_) { /* ignore */ }
    if (type === 'webview') {
      controller.setGuest(contents);
      contents.once('destroyed', () => {
        controller.clearState();
      });
    }
  };

  // 返回绑定函数，由 main.js 决定何时挂到 app 事件（在 ready 前 require 即可）。
  // 同时把控制面方法转发到 controller —— main.js 直接通过 bridge.xxx() 调用
  // （setActiveFeed / clearActiveFeed / applySettings / control），与文件顶部用法注释一致。
  const bridge = {
    controller,
    bind: (app) => {
      app.on('web-contents-created', onWebContentsCreated);
    },
    unbind: (app) => {
      app.removeListener('web-contents-created', onWebContentsCreated);
    },
    setGuest: (guest) => controller.setGuest(guest),
    getGuest: () => controller.getGuest(),
    dispose: () => controller.dispose(),
    applySettings: (settings) => controller.applySettings(settings),
    setActiveFeed: (feed) => controller.setActiveFeed(feed),
    clearActiveFeed: () => controller.clearActiveFeed(),
    control: (cmd, arg) => controller.control(cmd, arg)
  };
  return bridge;
}

module.exports = { createPageBridgeController, PageBridgeController, buildBridgeSource };
