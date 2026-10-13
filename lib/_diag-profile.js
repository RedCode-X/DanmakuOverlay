/* 临时诊断模块（仅当环境变量 DM_PROFILE_HTTP 非空时由 main.js 加载，生产默认不启用）：
 *
 * 提供本地 HTTP 服务（127.0.0.1:<port>）：
 *   GET /probe             —— 探测 guest 页面是否存在播放中的 <video>
 *   GET /profile?sec=12    —— 对 guest 所在渲染进程采集 12s 主线程 Tracing 并写盘
 *
 * 用途：定位“弹幕每隔几秒卡顿”的根因（哪些长任务 / 周期性任务占据 guest 主线程）。
 * 采集完成后本文件可整体删除。
 */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const { webContents } = require('electron');

const OUT_DIR = path.join(__dirname, '..', 'scripts');

const DIAG_PROBE = `(function () { try {
  var vs = document.querySelectorAll('video'); var out = [];
  for (var i = 0; i < vs.length; i++) {
    var v = vs[i];
    out.push({
      paused: v.paused, readyState: v.readyState,
      t: Math.round(v.currentTime * 10) / 10,
      dur: Math.round((v.duration || 0) * 10) / 10,
      playing: !v.paused && !v.ended && v.readyState > 1,
      overlay: !!document.getElementById('__dm_overlay_root'),
      bridge: !!window.__dmBridgeV1,
      src: String(v.currentSrc || '').slice(0, 90)
    });
  }
  var ss = [];
  var list = document.querySelectorAll('script[src]');
  for (var j = 0; j < list.length; j++) {
    var h = '';
    try { h = String(list[j].src || ''); } catch (_) {}
    if (/huaweicloud|obs\.|3d-platform/i.test(h) || j < 12) ss.push(h.slice(0, 160));
  }
  return { ok: true, url: location.href.slice(0, 140), title: document.title.slice(0, 60), videos: out, scripts: ss };
} catch (e) { return { ok: false, error: String(e && e.message || e) }; } })()`;

function log(...a) { console.log('[profile]', ...a); }

function collectFrames(frame, out) {
  if (!frame) return out;
  out.push(frame);
  for (const f of frame.frames || []) collectFrames(f, out);
  return out;
}

function findGuest() {
  const list = webContents.getAllWebContents();
  let guest = null;
  for (const wc of list) {
    let t = '';
    try { t = wc.getType(); } catch (_) {}
    if (t === 'webview') guest = wc; // 内置浏览器的 guest；只保留最后一个
  }
  if (!guest) {
    for (const wc of list) {
      let t = '';
      try { t = wc.getType(); } catch (_) {}
      if (t !== 'window' && /^https?:/i.test(wc.getURL())) { guest = wc; break; }
    }
  }
  return guest && !guest.isDestroyed() ? guest : null;
}

async function probeGuest(wc) {
  if (!wc) return { ok: false, error: 'no guest' };
  let top = null;
  try { top = wc.mainFrame; } catch (_) {}
  if (!top) return { ok: false, error: 'no main frame' };
  const frames = collectFrames(top, []);
  const all = [];
  for (const f of frames) {
    let url = '';
    try { url = f.url || ''; } catch (_) {}
    if (!/^https?:/i.test(url)) continue;
    const r = await f.executeJavaScript(DIAG_PROBE).catch((e) => ({ ok: false, error: String(e) }));
    if (r && r.ok) {
      r.frameUrl = url;
      all.push(r);
    }
  }
  const playing = all.some((r) => (r.videos || []).some((v) => v.playing));
  return { ok: true, playing, frames: all };
}

async function profileTrace(wc, seconds) {
  if (!wc || wc.isDestroyed()) throw new Error('guest gone');
  let attached = false;
  try {
    wc.debugger.attach('1.3');
    attached = true;
  } catch (e) {
    if (!/already/i.test(String(e && e.message || e))) throw e;
  }
  const events = [];
  let doneResolve = null;
  const done = new Promise((r) => { doneResolve = r; });
  const onMsg = (_ev, method, params) => {
    if (method === 'Tracing.dataCollected' && params && Array.isArray(params.value)) {
      for (const ev of params.value) events.push(ev);
    } else if (method === 'Tracing.tracingComplete') {
      if (doneResolve) doneResolve();
    }
  };
  wc.debugger.on('message', onMsg);
  try {
    await wc.debugger.sendCommand('Tracing.start', {
      categories: '-*,devtools.timeline,toplevel,v8.execute,v8,disabled-by-default-devtools.timeline.frame,disabled-by-default-devtools.timeline.stack',
      transferMode: 'ReportEvents'
    });
  } catch (e) {
    wc.debugger.removeListener('message', onMsg);
    if (attached) { try { wc.debugger.detach(); } catch (_) {} }
    throw e;
  }
  await new Promise((r) => setTimeout(r, seconds * 1000));
  try { await wc.debugger.sendCommand('Tracing.end'); } catch (_) {}
  await Promise.race([done, new Promise((r) => setTimeout(r, 3000))]);
  wc.debugger.removeListener('message', onMsg);
  if (attached) { try { wc.debugger.detach(); } catch (_) {} }
  return events;
}

function start(port) {
  const server = http.createServer(async (req, res) => {
    const send = (code, obj) => {
      res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(obj));
    };
    let u;
    try { u = new URL(req.url, 'http://127.0.0.1'); } catch (_) { return send(400, { error: 'bad url' }); }
    try {
      if (u.pathname === '/probe') {
        const st = await probeGuest(findGuest());
        return send(200, st);
      }
      if (u.pathname === '/profile') {
        const sec = Math.min(45, Math.max(3, Number(u.searchParams.get('sec')) || 12));
        const wc = findGuest();
        if (!wc) return send(400, { error: 'no guest webContents' });
        const st = await probeGuest(wc);
        if (!st.playing) return send(409, { error: 'no playing video', state: st });
        const t0 = Date.now();
        const events = await profileTrace(wc, sec);
        const file = path.join(OUT_DIR, `_perf_guest_${Date.now()}.json`);
        fs.writeFileSync(file, JSON.stringify({ boot: Date.now() - t0, events }), 'utf8');
        return send(200, {
          ok: true, seconds: sec, events: events.length,
          bytes: fs.statSync(file).size, file,
          playingState: st
        });
      }
      return send(404, { error: 'not found' });
    } catch (e) {
      return send(500, { error: String(e && e.message || e) });
    }
  });
  server.listen(port, '127.0.0.1', () => log('HTTP diag listening on 127.0.0.1:' + port));
}

module.exports = { start };
