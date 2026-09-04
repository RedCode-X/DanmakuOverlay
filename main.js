/**
 * 弹幕发射器 - 主进程
 *
 * 职责：
 *  - 创建透明、无边框、始终置顶的悬浮窗（覆盖在视频播放器上方）
 *  - 点击穿透控制（setIgnoreMouseEvents）
 *  - 全局快捷键注册
 *  - IPC 处理（本地文件读取 / 设置持久化）
 */
const { app, BrowserWindow, ipcMain, globalShortcut, screen } = require('electron');
const path = require('path');
const fs = require('fs');

let mainWindow = null;
let isPassthrough = false;

// ---------------- 设置持久化 ----------------

const DEFAULT_SETTINGS = {
  fontSize: 26,          // 弹幕字号(px)
  speed: 1.0,            // 滚动速度倍率
  opacity: 0.9,          // 弹幕不透明度(0~1)
  trackCount: 6,         // 滚动轨道数
  density: 0.8,          // 弹幕密度(0~1)
  offsetMs: 0,           // 时间轴偏移校准(毫秒, 负值=弹幕提前)
  colorMode: 'original'  // 颜色模式: original | white | vibrant
};

let settings = { ...DEFAULT_SETTINGS };

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
    console.error('[danmaku] 设置保存失败:', err.message);
  }
  return settings;
}

// ---------------- 点击穿透 ----------------

function setPassthrough(flag) {
  if (!mainWindow) return isPassthrough;
  isPassthrough = Boolean(flag);
  // forward: true 使窗口在穿透时仍能收到 mousemove，
  // 以便鼠标移到边缘热区时自动退出穿透。
  mainWindow.setIgnoreMouseEvents(isPassthrough, { forward: true });
  mainWindow.webContents.send('danmaku:passthrough', isPassthrough);
  return isPassthrough;
}

// ---------------- 窗口创建 ----------------

function createWindow() {
  const { width, height } = screen.getPrimaryDisplay().workAreaSize;

  mainWindow = new BrowserWindow({
    width,
    height,
    x: 0,
    y: 0,
    transparent: true,          // 背景完全透明
    frame: false,               // 无边框
    backgroundColor: '#00000000',
    alwaysOnTop: true,          // 始终置顶
    resizable: false,           // 关闭系统热区，缩放全部由"调整模式"自定义手柄完成
    minimizable: false,
    maximizable: false,
    hasShadow: false,
    skipTaskbar: true,          // 不占用任务栏
    fullscreenable: false,
    title: '弹幕发射器',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  // 置顶级别提到 screen-saver，确保覆盖在 PotPlayer/VLC 等播放器窗口之上
  mainWindow.setAlwaysOnTop(true, 'screen-saver');
  mainWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// ---------------- 全局快捷键 ----------------

function registerShortcuts() {
  const bindings = [
    ['CommandOrControl+Alt+D', 'toggleVisible'],     // 显示 / 隐藏
    ['CommandOrControl+Alt+P', 'togglePlay'],        // 播放 / 暂停
    ['CommandOrControl+Alt+Right', 'seekForward'],   // 快进 5s
    ['CommandOrControl+Alt+Left', 'seekBackward'],   // 快退 5s
    ['CommandOrControl+Alt+T', 'togglePassthrough'], // 点击穿透
    ['CommandOrControl+Alt+Q', 'quit']               // 退出
  ];

  for (const [accelerator, action] of bindings) {
    try {
      const ok = globalShortcut.register(accelerator, () => {
        if (action === 'quit') {
          app.quit();
          return;
        }
        if (!mainWindow) return;
        if (action === 'toggleVisible') {
          // 显示 / 隐藏由主进程直接处理
          if (mainWindow.isVisible()) mainWindow.hide();
          else mainWindow.show();
          return;
        }
        mainWindow.webContents.send('danmaku:shortcut', action);
      });
      if (!ok) {
        console.warn(`[danmaku] 快捷键注册失败(可能被占用): ${accelerator}`);
      }
    } catch (err) {
      console.warn(`[danmaku] 快捷键注册异常: ${accelerator}`, err.message);
    }
  }
}

// ---------------- IPC ----------------

// 读取本地弹幕数据文件（JSON 数组，或 { danmaku: [...] }）
ipcMain.handle('danmaku:loadFile', (_e, filePath) => {
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(raw);
    const list = Array.isArray(parsed) ? parsed : parsed.danmaku;
    if (!Array.isArray(list)) throw new Error('文件中未找到弹幕数组');
    return { ok: true, data: list };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// 内置采集数据集（桃花坞第5季），返回剧集索引
const BUILTIN_DIR = path.join(__dirname, 'data', 's5_mzc002005od4txd');
ipcMain.handle('danmaku:listBuiltin', () => {
  try {
    const indexFile = path.join(BUILTIN_DIR, 'index.json');
    if (!fs.existsSync(indexFile)) return { ok: true, data: null };
    const index = JSON.parse(fs.readFileSync(indexFile, 'utf-8'));
    return {
      ok: true,
      data: {
        name: '五十公里桃花坞 第5季',
        episodes: index.map((e) => ({
          ...e,
          filePath: path.join(BUILTIN_DIR, 'danmaku', e.file)
        }))
      }
    };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// 调整模式：按手柄拖拽实时调整窗口大小与位置
ipcMain.on('danmaku:resizeWindow', (_e, bounds) => {
  if (!mainWindow) return;
  const b = {
    x: Math.round(bounds.x),
    y: Math.round(bounds.y),
    width: Math.max(320, Math.round(bounds.width)),
    height: Math.max(200, Math.round(bounds.height))
  };
  mainWindow.setBounds(b);
});

ipcMain.handle('danmaku:togglePassthrough', () => setPassthrough(!isPassthrough));
ipcMain.handle('danmaku:setPassthrough', (_e, flag) => setPassthrough(flag));
ipcMain.handle('danmaku:saveSettings', (_e, patch) => saveSettings(patch));
ipcMain.handle('danmaku:loadSettings', () => loadSettings());

// ---------------- 生命周期 ----------------

app.whenReady().then(() => {
  loadSettings();
  createWindow();
  registerShortcuts();
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
});

app.on('window-all-closed', () => {
  app.quit();
});
