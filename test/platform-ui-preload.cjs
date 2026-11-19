const { contextBridge } = require('electron');
const noop = () => {};
const resolved = async () => ({ copied: true });
contextBridge.exposeInMainWorld('vault', {
  state: async () => ({
    platform: 'win32',
    items: [],
    folders: [],
    connectors: {
      wechat: {
        enabled: true,
        needsCacheGrant: true,
        status: 'waiting',
        message: '请选择数据目录',
      },
    },
  }),
  onChange: noop,
  onError: noop,
  onDragEnd: noop,
  copyOriginal: resolved,
  insert: resolved,
  openMain: noop,
  importFiles: resolved,
  pathFor: () => '',
  update: resolved,
  remove: resolved,
  reveal: resolved,
  copyPath: resolved,
  exportFiles: resolved,
  addFolder: resolved,
  removeFolder: resolved,
  scan: resolved,
  drag: noop,
  authorizeConnector: resolved,
  authorizeWechatCache: resolved,
  syncConnector: resolved,
  disableConnector: resolved,
  authorizePaste: resolved,
});
