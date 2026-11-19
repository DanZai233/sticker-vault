const { contextBridge } = require('electron');
const noop = () => {};
const resolved = async () => ({ copied: true });
const fixture = {
  platform: 'win32',
  ocr: { enabled: true, total: 0, done: 0, pending: 0, failed: 0 },
  startup: { enabled: false, requested: false, supported: true, message: 'Windows 启动项' },
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
};
let changed = () => {};
const operations = [];
contextBridge.exposeInMainWorld('vault', {
  state: async () => fixture,
  fixtureItems: async (items) => {
    fixture.items = items;
    changed(fixture);
  },
  operations: async () => operations,
  onOcrUpdate: noop,
  setOcrEnabled: async (enabled) => ({ enabled, total: 0, done: 0, pending: 0, failed: 0 }),
  setStartupEnabled: async (enabled) => ({ enabled, requested: enabled, supported: true }),
  openStartupSettings: resolved,
  onChange: (fn) => {
    changed = fn;
  },
  onError: noop,
  onDragEnd: noop,
  copyOriginal: async (id) => {
    operations.push({ type: 'copy', id });
    return { copied: true };
  },
  insert: async (id) => {
    operations.push({ type: 'insert', id });
    return { copied: true };
  },
  openMain: noop,
  importFiles: resolved,
  pathFor: () => '',
  update: async (id, patch) => {
    operations.push({ type: 'update', id, patch });
    Object.assign(
      fixture.items.find((item) => item.id === id),
      patch,
    );
    changed(fixture);
  },
  moveToFront: async (id) => {
    operations.push({ type: 'front', id });
    const item = fixture.items.find((item) => item.id === id);
    item.moveOrderAt = Date.now() + operations.length;
    fixture.items = [item, ...fixture.items.filter((i) => i.id !== id)];
    changed(fixture);
  },
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
