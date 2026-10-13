/**
 * 弹幕观影 - preload 脚本
 *
 * 通过 contextBridge 向渲染进程暴露安全的 window.danmaku API，
 * 渲染进程不直接接触 Node.js 能力。
 *
 * 该 preload 同时服务于两套界面：
 *  - renderer/app.html  一体化主界面（本地播放 + 网页模式 + 在线采集）
 *  - renderer/index.html legacy 透明悬浮窗（沿用旧 API，向后兼容）
 */
const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('danmaku', {
  // ================= 弹幕数据 =================

  // 读取本地弹幕 JSON（路径由主进程校验读取）
  loadFile: (filePath) => ipcRenderer.invoke('danmaku:loadFile', filePath),

  // 内置采集数据集（桃花坞第5季）剧集索引
  listBuiltin: () => ipcRenderer.invoke('danmaku:listBuiltin'),

  // 已通过在线采集落盘的数据
  listCollected: () => ipcRenderer.invoke('danmaku:listCollected'),

  // 将某个弹幕文件设为“网页模式当前数据源”（写入 dm-feed 活跃数据并推送页面桥）
  setActiveFeed: (payload) => ipcRenderer.invoke('danmaku:setActiveFeed', payload),
  clearActiveFeed: () => ipcRenderer.invoke('danmaku:clearActiveFeed'),

  // ================= 网页模式（页面桥） =================

  // 向激活视频下发控制：play | pause | seek | offset | setVisible | clearData
  webControl: (cmd, arg) => ipcRenderer.send('danmaku:webControl', { cmd, arg }),

  // 下发弹幕渲染参数（含持久化）
  webApplySettings: (patch) => ipcRenderer.send('danmaku:webApplySettings', patch),

  // 视频/弹幕状态（约 600ms 一帧，由主进程轮询 guest 后广播）
  onVideoState: (callback) => {
    const listener = (_e, st) => callback(st);
    ipcRenderer.on('danmaku:videoState', listener);
    return () => ipcRenderer.removeListener('danmaku:videoState', listener);
  },

  // 网页换集 / 换源事件（弹幕需重新选择）
  onVideoChanged: (callback) => {
    const listener = (_e, st) => callback(st);
    ipcRenderer.on('danmaku:videoChanged', listener);
    return () => ipcRenderer.removeListener('danmaku:videoChanged', listener);
  },

  // webview 导航状态（地址栏同步）
  onWebNav: (callback) => {
    const listener = (_e, nav) => callback(nav);
    ipcRenderer.on('danmaku:webNav', listener);
    return () => ipcRenderer.removeListener('danmaku:webNav', listener);
  },

  // ================= 在线采集（腾讯弹幕） =================

  // 尝试从 URL 中识别 vid
  extractVid: (url) => ipcRenderer.invoke('danmaku:extractVid', url),
  // 开始采集：resolve 于完成/取消/失败
  fetchStart: (payload) => ipcRenderer.invoke('danmaku:fetchStart', payload),
  fetchCancel: () => ipcRenderer.invoke('danmaku:fetchCancel'),
  onFetchProgress: (callback) => {
    const listener = (_e, p) => callback(p);
    ipcRenderer.on('danmaku:fetchProgress', listener);
    return () => ipcRenderer.removeListener('danmaku:fetchProgress', listener);
  },

  // ================= 本地模式 =================

  // 系统对话框选择本地视频 / 弹幕 JSON
  openVideoDialog: () => ipcRenderer.invoke('dialog:openVideo'),
  openDanmakuDialog: () => ipcRenderer.invoke('dialog:openDanmaku'),
  // 打开已采集数据目录
  showCollectedDir: () => ipcRenderer.invoke('shell:showCollected'),

  // ================= 窗口控制 =================

  minimize: () => ipcRenderer.send('win:minimize'),
  toggleMaximize: () => ipcRenderer.send('win:toggleMaximize'),
  close: () => ipcRenderer.send('win:close'),
  isMaximized: () => ipcRenderer.invoke('win:isMaximized'),
  onMaximized: (callback) => {
    const listener = (_e, flag) => callback(flag);
    ipcRenderer.on('win:maximized', listener);
    return () => ipcRenderer.removeListener('win:maximized', listener);
  },

  // ================= legacy 悬浮窗（向后兼容） =================

  // 从 <input type="file"> 的 File 对象取回真实路径
  getPathForFile: (file) => webUtils.getPathForFile(file),

  // 打开 legacy 透明置顶悬浮窗（供外部播放器叠加弹幕）
  openLegacy: () => ipcRenderer.invoke('danmaku:openLegacy'),

  // 调整 legacy 窗口大小 / 位置（调整模式拖拽手柄）
  resizeWindow: (bounds) => ipcRenderer.send('danmaku:resizeWindow', bounds),

  // 点击穿透控制（legacy）
  togglePassthrough: () => ipcRenderer.invoke('danmaku:togglePassthrough'),
  setPassthrough: (flag) => ipcRenderer.invoke('danmaku:setPassthrough', flag),

  // ================= 设置与广播 =================

  // 设置持久化（两套界面共用同一份设置）
  saveSettings: (patch) => ipcRenderer.invoke('danmaku:saveSettings', patch),
  loadSettings: () => ipcRenderer.invoke('danmaku:loadSettings'),

  // 主进程广播：全局快捷键触发
  onShortcut: (callback) => {
    const listener = (_e, cmd) => callback(cmd);
    ipcRenderer.on('danmaku:shortcut', listener);
    return () => ipcRenderer.removeListener('danmaku:shortcut', listener);
  },

  // 主进程广播：点击穿透状态变化（legacy）
  onPassthrough: (callback) => {
    const listener = (_e, flag) => callback(flag);
    ipcRenderer.on('danmaku:passthrough', listener);
    return () => ipcRenderer.removeListener('danmaku:passthrough', listener);
  }
});
