/**
 * 弹幕发射器 - preload 脚本
 *
 * 通过 contextBridge 向渲染进程暴露安全的 window.danmaku API，
 * 渲染进程不直接接触 Node.js 能力。
 */
const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('danmaku', {
  // 读取本地弹幕数据文件
  loadFile: (filePath) => ipcRenderer.invoke('danmaku:loadFile', filePath),

  // 内置采集数据集（桃花坞第5季）剧集索引
  listBuiltin: () => ipcRenderer.invoke('danmaku:listBuiltin'),

  // 从 <input type="file"> 的 File 对象取回真实路径
  getPathForFile: (file) => webUtils.getPathForFile(file),

  // 调整窗口大小 / 位置（调整模式拖拽手柄）
  resizeWindow: (bounds) => ipcRenderer.send('danmaku:resizeWindow', bounds),

  // 点击穿透控制
  togglePassthrough: () => ipcRenderer.invoke('danmaku:togglePassthrough'),
  setPassthrough: (flag) => ipcRenderer.invoke('danmaku:setPassthrough', flag),

  // 设置持久化
  saveSettings: (patch) => ipcRenderer.invoke('danmaku:saveSettings', patch),
  loadSettings: () => ipcRenderer.invoke('danmaku:loadSettings'),

  // 主进程广播：全局快捷键触发
  onShortcut: (callback) => {
    const listener = (_e, cmd) => callback(cmd);
    ipcRenderer.on('danmaku:shortcut', listener);
    return () => ipcRenderer.removeListener('danmaku:shortcut', listener);
  },

  // 主进程广播：点击穿透状态变化
  onPassthrough: (callback) => {
    const listener = (_e, flag) => callback(flag);
    ipcRenderer.on('danmaku:passthrough', listener);
    return () => ipcRenderer.removeListener('danmaku:passthrough', listener);
  }
});
