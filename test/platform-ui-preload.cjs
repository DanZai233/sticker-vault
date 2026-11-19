const { contextBridge } = require('electron');
const noop = () => {};
const resolved = async () => ({ copied: true });
const fixture = {
  platform: 'win32',
  transferState: {
    dav: { url: 'https://example.test/dav/', username: 'test', hasPassword: false },
    transfer: { busy: false, phase: 'idle' },
  },
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
  onTransferUpdate: noop,
  transferState: async () => fixture.transferState,
  saveWebDav: async (input) => {
    operations.push({ type: 'dav-save', url: input.url });
    fixture.transferState.dav = {
      url: input.url,
      username: input.username,
      hasPassword: !!input.password,
    };
    return fixture.transferState.dav;
  },
  forgetWebDavPassword: async () => {
    fixture.transferState.dav.hasPassword = false;
    return fixture.transferState.dav;
  },
  exportBackup: async () => {
    operations.push({ type: 'backup-export' });
    return { message: '已导出测试备份' };
  },
  importBackup: async () => {
    operations.push({ type: 'backup-import' });
    return { message: '已合并测试备份' };
  },
  testWebDav: async () => {
    operations.push({ type: 'dav-test' });
    return { message: '连接成功' };
  },
  syncWebDav: async () => {
    operations.push({ type: 'dav-sync' });
    return { message: '手动同步完成' };
  },
  cancelTransfer: noop,
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
