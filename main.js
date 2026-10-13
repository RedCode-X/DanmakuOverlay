/**
 * 弹幕观影 - 主进程
 *
 * 职责：
 *  - 一体化主窗口（renderer/app.html）：在线浏览（内嵌 webview）+ 本地播放 双模式
 *  - 网页模式：页面桥注入调度（lib/bridge-injector），弹幕自动叠加到网页 <video> 上并绑定其时间轴
 *  - 弹幕数据通路：内置数据 / 本地 JSON / 腾讯弹幕在线采集（lib/barrage-fetch）
 *  - 自定义协议：dm-feed（喂给页面桥的弹幕数据）、dm-video（本地视频文件流式播放）
 *  - 保留 legacy 透明悬浮窗模式（renderer/index.html），供外部播放器场景使用
 *  - 全局快捷键、设置持久化
 */
const { app, BrowserWindow, ipcMain, globalShortcut, screen, dialog, session, protocol, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const { Readable } = require('stream');
const { pathToFileURL } = require('url');
const { createPageBridgeController } = require('./lib/bridge-injector');
const barrage = require('./lib/barrage-fetch');
const DM_PROFILE_PORT = process.env.DM_PROFILE_HTTP ? (Number(process.env.DM_PROFILE_HTTP) || 9444) : 0; // 临时诊断服务端口（0=关闭）

// ---------------- 自定义协议注册（必须在 app ready 前） ----------------

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'dm-feed',
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true }
  },
  {
    scheme: 'dm-video',
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true }
  }
]);

// ---------------- 常量 ----------------

const HOME_URL = 'https://dmxq23.com/';            // 启动起始页（用户主观影站点，可被地址栏任意替换）
const BUILTIN_DIR = path.join(__dirname, 'data', 's5_mzc002005od4txd');
const WEB_PARTITION = 'persist:dm-web';            // webview 持久会话（保存登录态）

// ---------------- 全局状态 ----------------

let mainWindow = null;          // 一体化主窗口
let legacyWindow = null;        // legacy 透明悬浮窗
let legacyPassthrough = false;
let settings = null;
let activeFeed = null;          // 当前推送给页面桥的弹幕数据 { key, filePath, title, count, rawText }
let bridge = null;

// ---------------- 工具 ----------------

// 运行日志：控制台输出 + 落盘到 userData（便于排查 webview 导航等问题，不污染项目目录）
function logFile() {
  try { return path.join(app.getPath('userData'), 'danmaku-app.log'); } catch (_) { return ''; }
}
function log(...args) {
  console.log('[danmaku]', ...args);
  const file = logFile();
  if (!file) return;
  try {
    const line = args.map((a) => {
      if (a instanceof Error) return a.stack || a.message;
      if (typeof a === 'string') return a;
      try { return JSON.stringify(a); } catch (_) { return String(a); }
    }).join(' ');
    fs.appendFileSync(file, `[${new Date().toLocaleTimeString('zh-CN', { hour12: false })}] ${line}\n`);
  } catch (_) { /* 写日志失败不影响运行 */ }
}

function collectedDir() {
  return path.join(app.getPath('userData'), 'collected');
}

function sendToWindow(win, channel, payload) {
  if (win && !win.isDestroyed()) {
    try { win.webContents.send(channel, payload); } catch (_) { /* ignore */ }
  }
}

function broadcast(channel, payload) {
  sendToWindow(mainWindow, channel, payload);
  sendToWindow(legacyWindow, channel, payload);
}

// ---------------- 设置持久化 ----------------

const DEFAULT_SETTINGS = {
  fontSize: 26,          // 弹幕字号(px)
  speed: 1.0,            // 滚动速度倍率
  opacity: 0.9,          // 弹幕不透明度(0~1)
  trackCount: 5,         // 滚动轨道数（默认更克制，避免铺满屏幕）
  density: 0.65,         // 弹幕密度(0~1)（默认更克制）
  maxActive: 10,         // 同屏同时显示的弹幕条数上限
  offsetMs: 0,           // 时间轴偏移校准(毫秒, 负值=弹幕提前)
  colorMode: 'original', // 颜色模式: original | white | vibrant
  homeUrl: HOME_URL      // 在线模式起始页
};

function settingsFile() {
  return path.join(app.getPath('userData'), 'danmaku-settings.json');
}

function loadSettings() {
  try {
    const raw = fs.readFileSync(settingsFile(), 'utf-8');
    settings = { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
  } catch (_) {
    settings = { ...DEFAULT_SETTINGS };
  }
  return settings;
}

function saveSettings(patch) {
  settings = { ...settings, ...patch };
  try {
    fs.mkdirSync(path.dirname(settingsFile()), { recursive: true });
    fs.writeFileSync(settingsFile(), JSON.stringify(settings, null, 2));
  } catch (err) {
    log('设置保存失败:', err.message);
  }
  return settings;
}

// ---------------- 主窗口：一体化弹幕观影 ----------------

function createMainWindow() {
  const { workArea } = screen.getPrimaryDisplay();
  mainWindow = new BrowserWindow({
    width: Math.min(1400, workArea.width - 40),
    height: Math.min(900, workArea.height - 40),
    minWidth: 940,
    minHeight: 600,
    x: undefined,
    y: undefined,
    show: false,
    frame: false,               // 自绘标题栏
    backgroundColor: '#0B0E13',
    title: '弹幕观影',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,           // webview tag 需要；nodeIntegration 仍为 false，页面不可信内容只运行于 webview guest
      webviewTag: true,
      spellcheck: false
    }
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'app.html'));

  // 渲染层控制台 / preload 错误转发到运行日志（排查绑定失效等疑难）
  mainWindow.webContents.on('console-message', (_ev, level, message, line, sourceId) => {
    try {
      const lv = ['verbose', 'info', 'warning', 'error'][Number(level)] || `lvl${level}`;
      log(`[renderer:${lv}] ${message}  (${sourceId}:${line})`);
    } catch (_) { /* ignore */ }
  });
  mainWindow.webContents.on('preload-error', (_e, preloadPath, error) => {
    log('[renderer] preload 脚本错误:', preloadPath, String((error && error.message) || error));
  });

  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.on('maximize', () => sendToWindow(mainWindow, 'win:maximized', true));
  mainWindow.on('unmaximize', () => sendToWindow(mainWindow, 'win:maximized', false));
  mainWindow.on('closed', () => { mainWindow = null; });
}

// ---------------- Legacy：透明悬浮窗（兼容模式） ----------------

function createLegacyWindow() {
  if (legacyWindow && !legacyWindow.isDestroyed()) {
    legacyWindow.show();
    return legacyWindow;
  }
  const { width, height } = screen.getPrimaryDisplay().workAreaSize;
  legacyWindow = new BrowserWindow({
    width,
    height,
    x: 0,
    y: 0,
    transparent: true,
    frame: false,
    backgroundColor: '#00000000',
    alwaysOnTop: true,
    resizable: false,
    minimizable: false,
    maximizable: false,
    hasShadow: false,
    skipTaskbar: true,
    fullscreenable: false,
    title: '弹幕发射器（悬浮窗）',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  legacyWindow.setAlwaysOnTop(true, 'screen-saver');
  legacyWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  legacyWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  legacyWindow.on('closed', () => { legacyWindow = null; });
  return legacyWindow;
}

function toggleLegacyVisible() {
  if (!legacyWindow || legacyWindow.isDestroyed()) return;
  if (legacyWindow.isVisible()) legacyWindow.hide();
  else legacyWindow.show();
}

// ---------------- 自定义协议 ----------------

/** dm-video：流式播放本地视频文件（支持 Range 请求以允许 seek） */
function registerVideoProtocol(sess) {
  sess.protocol.handle('dm-video', async (request) => {
    try {
      const u = new URL(request.url);
      const filePath = decodeURIComponent(u.searchParams.get('p') || '');
      if (!filePath || !fs.existsSync(filePath)) {
        return new Response('Not Found', { status: 404 });
      }
      const size = fs.statSync(filePath).size;
      const mime = mimeFor(filePath);
      const range = request.headers.get('range');
      const headers = {
        'Accept-Ranges': 'bytes',
        'Content-Type': mime,
        'Cache-Control': 'no-store'
      };
      if (range) {
        const m = /bytes=(\d*)-(\d*)/.exec(range);
        const start = m && m[1] !== '' ? parseInt(m[1], 10) : 0;
        let end = m && m[2] !== '' ? parseInt(m[2], 10) : size - 1;
        if (Number.isNaN(start) || start >= size) {
          return new Response('Range Not Satisfiable', { status: 416, headers: { 'Content-Range': `bytes */${size}` } });
        }
        end = Math.max(start, Math.min(end, size - 1));
        const body = Readable.toWeb(fs.createReadStream(filePath, { start, end }));
        return new Response(body, {
          status: 206,
          headers: { ...headers, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': String(end - start + 1) }
        });
      }
      const body = Readable.toWeb(fs.createReadStream(filePath));
      return new Response(body, { status: 200, headers: { ...headers, 'Content-Length': String(size) } });
    } catch (_) {
      return new Response('Bad Request', { status: 400 });
    }
  });
}

function mimeFor(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const table = {
    '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.mkv': 'video/x-matroska',
    '.webm': 'video/webm', '.mov': 'video/quicktime', '.avi': 'video/x-msvideo',
    '.flv': 'video/x-flv', '.wmv': 'video/x-ms-wmv', '.ts': 'video/mp2t',
    '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.flac': 'audio/flac', '.wav': 'audio/wav'
  };
  return table[ext] || 'application/octet-stream';
}

/** 页面桥数据源：dm-feed://feed/<key> */
function registerFeedProtocol(sess) {
  sess.protocol.handle('dm-feed', async (request) => {
    try {
      const u = new URL(request.url);
      if (u.hostname !== 'feed') return new Response('Not Found', { status: 404 });
      const key = decodeURIComponent(u.pathname.replace(/^\//, ''));
      if (activeFeed && activeFeed.key === key && activeFeed.rawText) {
        return new Response(activeFeed.rawText, {
          headers: {
            'Content-Type': 'application/json; charset=utf-8',
            'Access-Control-Allow-Origin': '*'
          }
        });
      }
      return new Response('Not Found', { status: 404 });
    } catch (_) {
      return new Response('Bad Request', { status: 400 });
    }
  });
}

// webview guest 的 UA 覆盖：去掉 Electron / 应用名标记，伪装成普通桌面 Chrome。
// 影视站（如 dmxq23 ArtPlayer 加密播放器）常在运行时检测 navigator.userAgent 含
// "Electron" 或应用名即判定为嵌入/自动化环境，拒绝初始化播放器（表现为白屏）。
const WEB_CHROME_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.6478.127 Safari/537.36';

function registerProtocols() {
  registerVideoProtocol(session.defaultSession);        // app 本地模式播视频
  try {
    const webSess = session.fromPartition(WEB_PARTITION); // webview guest 会话
    webSess.setUserAgent(WEB_CHROME_UA);                 // 规避站点 UA 环境检测
    registerFeedProtocol(webSess);
    registerBlankJsProtocol(webSess);
  } catch (err) {
    log('注册网页会话自定义协议失败:', err.message);
  }
}

/** dm-blank：返回“空 JS 内容”的本地协议，用于把重型第三方脚本替换为空壳（加载成功但无事发生） */
function registerBlankJsProtocol(sess) {
  try {
    sess.protocol.handle('dm-blank', async () => new Response('', {
      headers: { 'Content-Type': 'text/javascript; charset=utf-8' }
    }));
  } catch (err) {
    log('注册 dm-blank 协议失败:', err.message);
  }
}

// ---------------- 页面桥（网页模式弹幕注入） ----------------

function setupBridge() {
  bridge = createPageBridgeController({
    onState: (st) => sendToWindow(mainWindow, 'danmaku:videoState', st),
    onVideoChanged: (st) => {
      // 网页换集 / 换源：弹幕不再匹配，清空并提示
      if (bridge) bridge.clearActiveFeed();
      sendToWindow(mainWindow, 'danmaku:videoChanged', st);
    },
    debug: (...a) => log('[bridge]', ...a)
  });
  bridge.bind(app);

  // webview 主 frame 导航（供地址栏同步 + 加载失败可观测）
  app.on('web-contents-created', (_e, contents) => {
    let type = '';
    try { type = contents.getType(); } catch (_) { /* ignore */ }
    if (type !== 'webview') return;
    const navLog = (...a) => log('[webview]', ...a);
    contents.on('did-start-navigation', (ev, url, isInPlace, isMainFrame) => {
      if (isMainFrame) navLog('导航开始 →', url);
    });
    contents.on('did-fail-load', (_ev, code, desc, validatedURL, isMainFrame) => {
      if (!isMainFrame) return;
      navLog('导航失败 [', code, ']', desc, '→', validatedURL);
    });
    contents.on('did-navigate', (ev, url) => {
      if (!/^https?:/i.test(url)) return;
      navLog('导航完成 →', url);
      sendToWindow(mainWindow, 'danmaku:webNav', {
        url,
        canGoBack: contents.canGoBack(),
        canGoForward: contents.canGoForward()
      });
    });
  });
}

// ---------------- 内置数据索引（磁盘文件名为权威标题） ----------------

function listBuiltinData() {
  const indexFile = path.join(BUILTIN_DIR, 'index.json');
  const danmakuDir = path.join(BUILTIN_DIR, 'danmaku');
  if (!fs.existsSync(indexFile) || !fs.existsSync(danmakuDir)) return null;

  let byFile = {};
  try {
    const index = JSON.parse(fs.readFileSync(indexFile, 'utf8'));
    for (const e of index) {
      if (e && e.file) byFile[e.file] = e;
    }
  } catch (_) { byFile = {}; }

  const files = fs.readdirSync(danmakuDir)
    .filter((f) => f.toLowerCase().endsWith('.json'))
    .sort((a, b) => a.localeCompare(b, 'zh-CN', { numeric: true }));

  const episodes = files.map((f) => {
    const meta = byFile[f] || {};
    return {
      title: f.replace(/\.json$/i, ''),
      file: f,
      count: Number(meta.count) || 0,
      vid: meta.vid || '',
      filePath: path.join(danmakuDir, f)
    };
  });
  return { name: '五十公里桃花坞 第5季（内置）', episodes };
}

// ---------------- IPC ----------------

function isFromMain(webContents) {
  return mainWindow && webContents === mainWindow.webContents;
}

function registerIpc() {
  // ---- 窗口控制（自绘标题栏）----
  ipcMain.on('win:minimize', (e) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    if (win) win.minimize();
  });
  ipcMain.on('win:toggleMaximize', (e) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    if (!win) return;
    if (win.isMaximized()) win.unmaximize();
    else win.maximize();
  });
  ipcMain.on('win:close', (e) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    if (win) win.close();
  });
  ipcMain.handle('win:isMaximized', (e) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    return win ? win.isMaximized() : false;
  });

  // ---- 文件对话框 ----
  ipcMain.handle('dialog:openVideo', async (e) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    const r = await dialog.showOpenDialog(win, {
      title: '选择本地视频文件',
      properties: ['openFile'],
      filters: [
        { name: '视频 / 音频', extensions: ['mp4', 'mkv', 'webm', 'mov', 'avi', 'flv', 'wmv', 'm4v', 'ts', 'mp3', 'm4a', 'flac', 'wav'] }
      ]
    });
    if (r.canceled || !r.filePaths.length) return { path: null };
    return { path: r.filePaths[0] };
  });
  ipcMain.handle('dialog:openDanmaku', async (e) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    const r = await dialog.showOpenDialog(win, {
      title: '选择弹幕 JSON 文件',
      properties: ['openFile'],
      filters: [{ name: '弹幕 JSON', extensions: ['json'] }]
    });
    if (r.canceled || !r.filePaths.length) return { path: null };
    return { path: r.filePaths[0] };
  });
  ipcMain.handle('shell:showCollected', () => {
    const dir = collectedDir();
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    shell.openPath(dir);
    return { ok: true };
  });

  // ---- 弹幕数据读取（通用，app 本地模式 与 legacy 共用）----
  // 规范化弹幕条目：与页面桥 / 采集模块保持同构，供计数与本地引擎渲染共用
  function normalizeDanmaku(list) {
    if (!Array.isArray(list)) return [];
    const out = [];
    for (const d of list) {
      if (!d || typeof d !== 'object') continue;
      const time = Number(d.time);
      if (!Number.isFinite(time) || time < 0) continue;
      const text = String(d.text || '').trim();
      if (!text) continue;
      const type = (d.type === 'top' || d.type === 'bottom') ? d.type : 'scroll';
      const item = { time, type, text };
      if (typeof d.color === 'string' && d.color.trim()) item.color = d.color.trim();
      out.push(item);
    }
    return out;
  }

  ipcMain.handle('danmaku:loadFile', (_e, filePath) => {
    try {
      const raw = fs.readFileSync(filePath, 'utf-8');
      const parsed = JSON.parse(raw);
      const list = Array.isArray(parsed) ? parsed : parsed.danmaku;
      if (!Array.isArray(list)) throw new Error('文件中未找到弹幕数组');
      return { ok: true, data: normalizeDanmaku(list) };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('danmaku:listBuiltin', () => {
    const data = listBuiltinData();
    return { ok: true, data };
  });

  ipcMain.handle('danmaku:listCollected', () => {
    const list = barrage.listCollected(collectedDir());
    return { ok: true, data: list.map((e) => ({ ...e })) };
  });

  // ---- 弹幕数据源下发（网页模式：写 dm-feed 活跃数据并推送页面桥）----
  ipcMain.handle('danmaku:setActiveFeed', (e, payload) => {
    const filePath = payload && payload.filePath;
    if (!filePath || !fs.existsSync(filePath)) {
      return { ok: false, error: '文件不存在' };
    }
    try {
      const rawText = fs.readFileSync(filePath, 'utf-8');
      let count = 0;
      try {
        const parsed = JSON.parse(rawText);
        const list = Array.isArray(parsed) ? parsed : parsed.danmaku;
        count = normalizeDanmaku(list).length;
      } catch (_) { count = 0; }
      const key = `k${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
      activeFeed = {
        key,
        filePath,
        title: (payload && payload.title) || path.basename(filePath, path.extname(filePath)),
        count,
        rawText
      };
      if (bridge) bridge.setActiveFeed({ key, feedUrl: `dm-feed://feed/${key}` });
      log(`弹幕数据已下发: ${activeFeed.title} (${count})`);
      return { ok: true, key, count, title: activeFeed.title };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('danmaku:clearActiveFeed', () => {
    try {
      activeFeed = null;
      if (bridge) bridge.clearActiveFeed();
      return { ok: true };
    } catch (err) {
      log('清空弹幕数据失败:', err.message);
      return { ok: false, error: err.message };
    }
  });

  // ---- 网页模式控制转发到页面桥 ----
  ipcMain.on('danmaku:webControl', (e, payload) => {
    if (!isFromMain(e.sender) || !bridge || !payload) return;
    const { cmd, arg } = payload;
    bridge.control(cmd, arg);
  });
  ipcMain.on('danmaku:webApplySettings', (e, patch) => {
    if (!isFromMain(e.sender) || !bridge) return;
    bridge.applySettings({ ...settings, ...(patch || {}) });
  });

  // ---- 弹幕参数与持久化 ----
  ipcMain.handle('danmaku:saveSettings', (e, patch) => saveSettings(patch));
  ipcMain.handle('danmaku:loadSettings', () => loadSettings());

  // ---- 腾讯弹幕在线采集 ----
  ipcMain.handle('danmaku:extractVid', async (_e, url) => {
    const r = await barrage.resolveVid(String(url || ''));
    return { ok: true, vid: r.vid || null, title: r.title || '', source: r.source || '', error: r.error || '' };
  });

  ipcMain.handle('danmaku:fetchStart', async (e, payload) => {
    const input = String((payload && (payload.input || payload.vid)) || '').trim();
    const title = payload && payload.title;
    const sender = e.sender;
    const onProgress = (p) => {
      if (!sender.isDestroyed()) {
        try { sender.send('danmaku:fetchProgress', { vid: input, ...p }); } catch (_) { /* ignore */ }
      }
    };
    const result = await barrage.startCollect({ vid: input, title, dataDir: collectedDir(), onProgress });
    return result;
  });

  ipcMain.handle('danmaku:fetchCancel', () => {
    barrage.cancelCollect();
    return { ok: true };
  });

  // ---- Legacy 悬浮窗专属 ----
  ipcMain.handle('danmaku:openLegacy', () => {
    createLegacyWindow();
    return { ok: true };
  });
  ipcMain.handle('danmaku:setPassthrough', (_e, flag) => {
    if (!legacyWindow) return false;
    legacyPassthrough = Boolean(flag);
    legacyWindow.setIgnoreMouseEvents(legacyPassthrough, { forward: true });
    sendToWindow(legacyWindow, 'danmaku:passthrough', legacyPassthrough);
    return legacyPassthrough;
  });
  ipcMain.handle('danmaku:togglePassthrough', () => {
    if (!legacyWindow) return false;
    legacyPassthrough = !legacyPassthrough;
    legacyWindow.setIgnoreMouseEvents(legacyPassthrough, { forward: true });
    sendToWindow(legacyWindow, 'danmaku:passthrough', legacyPassthrough);
    return legacyPassthrough;
  });

  ipcMain.on('danmaku:resizeWindow', (_e, bounds) => {
    if (!legacyWindow) return;
    const b = {
      x: Math.round(bounds.x),
      y: Math.round(bounds.y),
      width: Math.max(320, Math.round(bounds.width)),
      height: Math.max(200, Math.round(bounds.height))
    };
    legacyWindow.setBounds(b);
  });
}

// ---------------- 全局快捷键 ----------------

function registerShortcuts() {
  const bindings = [
    ['CommandOrControl+Alt+D', 'toggleDanmaku'],     // 显示 / 隐藏弹幕层
    ['CommandOrControl+Alt+P', 'togglePlay'],        // 播放 / 暂停
    ['CommandOrControl+Alt+Right', 'seekForward'],   // 快进 5s
    ['CommandOrControl+Alt+Left', 'seekBackward'],   // 快退 5s
    ['CommandOrControl+Alt+T', 'togglePassthrough'], // 点击穿透（仅 legacy）
    ['CommandOrControl+Alt+L', 'reloadDanmaku'],     // 重载当前弹幕数据
    ['CommandOrControl+Alt+Q', 'quit']               // 退出
  ];

  const handle = (action) => {
    if (action === 'quit') {
      app.quit();
      return;
    }
    if (action === 'toggleDanmaku') {
      // 焦点在 legacy（悬浮窗）时切换其窗口显隐，否则视为主窗口弹幕层开关
      if (mainWindow && mainWindow.isFocused()) {
        sendToWindow(mainWindow, 'danmaku:shortcut', action);
      } else if (legacyWindow && legacyWindow.isVisible()) {
        toggleLegacyVisible();
      } else {
        sendToWindow(mainWindow, 'danmaku:shortcut', action);
      }
      return;
    }
    if (action === 'reloadDanmaku') {
      sendToWindow(mainWindow, 'danmaku:shortcut', action);
      return;
    }
    if (action === 'togglePassthrough') {
      sendToWindow(legacyWindow, 'danmaku:shortcut', action);
      return;
    }
    // play/pause / seek：定向到当前聚焦的窗口（悬浮窗与主窗口各自按模式处理）
    const focused = BrowserWindow.getFocusedWindow();
    if (focused === legacyWindow) {
      sendToWindow(legacyWindow, 'danmaku:shortcut', action);
    } else {
      sendToWindow(mainWindow, 'danmaku:shortcut', action);
    }
  };

  for (const [accelerator, action] of bindings) {
    try {
      if (!globalShortcut.register(accelerator, () => handle(action))) {
        log(`快捷键注册失败(可能被占用): ${accelerator}`);
      }
    } catch (err) {
      log(`快捷键注册异常: ${accelerator}`, err.message);
    }
  }
}

// ---------------- 会话层请求拦截（拦截网页注入的重型第三方脚本） ----------------

// 拦截清单：只拦截“已证实导致周期性卡顿”的单个脚本文件，避免误伤同域的正常库
// （jQuery / artplayer 播放器 / lazyload / history 等均与它同域）。
// 已证实：该脚本为 jsjiami v7 混淆产物，每 2s 强占渲染主线程 300~640ms（用 CDP Tracing 抓到）。
// 通过 URL 片段匹配，资源类型限定为 script，样式/图片/字体/XHR 一律放行。
const BLOCKED_SCRIPT_URL_FRAGS = ['/25b65abca250cdc78aa35a2e73d5cefb.min'];
const DM_BLOCK_3D = process.env.DM_BLOCK_3D === '1'; // 默认关闭：该脚本被站点播放鉴权依赖，拦截会致无法播放

function setupWebRequestBlock() {
  try {
    const ses = session.fromPartition(WEB_PARTITION);
    const frags = DM_BLOCK_3D ? BLOCKED_SCRIPT_URL_FRAGS : [];
    if (!frags.length) return;
    // 命中时不做 cancel（会断站点脚本加载链），而是重定向到“空 JS”协议：
    // 脚本以 200 加载成功但内容为空 → 无 2s 重型定时器，同时播放链路不受影响。
    ses.webRequest.onBeforeRequest({ urls: ['*://*/*'] }, (details, callback) => {
      const hit = details.resourceType === 'script' && frags.some((f) => details.url.includes(f));
      if (hit) {
        log('替换重型脚本为空壳:', details.url.slice(0, 220));
        callback({ redirectURL: 'dm-blank://blank/empty.js' });
      } else {
        callback({});
      }
    });
    log('webRequest 脚本替换已生效:', frags.join(', '));
  } catch (err) {
    log('webRequest 替换设置失败', err.message);
  }
}

// ---------------- 生命周期 ----------------

app.whenReady().then(() => {
  log('app ready：主进程启动');
  if (DM_PROFILE_PORT) {
    try { require('./lib/_diag-profile').start(DM_PROFILE_PORT); } catch (err) { log('诊断服务启动失败', err.message); }
  }
  loadSettings();
  registerProtocols();
  setupWebRequestBlock();
  setupBridge();
  createMainWindow();
  registerShortcuts();
  registerIpc();
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
});

app.on('window-all-closed', () => {
  if (legacyWindow && !legacyWindow.isDestroyed()) {
    legacyWindow.destroy();
  }
  app.quit();
});
