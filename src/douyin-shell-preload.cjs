const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('douyinWindow', {
  action: (action) => ipcRenderer.invoke('douyin-window-action', action),
  onStatus: (callback) => ipcRenderer.on('douyin-window-status', (_, message) => callback(message)),
});
