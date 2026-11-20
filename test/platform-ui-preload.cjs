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
  trash: [],
  importReports: [],
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
  onItemUpdate: noop,
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
  remove: async (ids) => {
    const removed = fixture.items.filter((item) => ids.includes(item.id));
    fixture.items = fixture.items.filter((item) => !ids.includes(item.id));
    fixture.trash.push(...removed.map((item) => ({ ...item, deletedAt: Date.now() })));
    changed(fixture);
    return { count: removed.length, ids: removed.map((item) => item.id) };
  },
  restoreTrash: async (ids) => {
    const restored = fixture.trash.filter((item) => ids.includes(item.id));
    fixture.items.push(...restored);
    fixture.trash = fixture.trash.filter((item) => !ids.includes(item.id));
    changed(fixture);
    return { restored: restored.length, failed: [] };
  },
  discardTrash: async (ids) => {
    fixture.trash = fixture.trash.filter((item) => !ids.includes(item.id));
    changed(fixture);
    return { removed: ids.length, failed: [] };
  },
  fixtureReport: async () => {
    fixture.importReports = [
      {
        id: 'fixture-report',
        createdAt: Date.now(),
        source: '测试',
        counts: { added: 1, restored: 0, duplicate: 0, skipped: 0, failed: 1 },
      },
    ];
    changed(fixture);
  },
  importReport: async (id) => ({
    ...fixture.importReports[0],
    details: [
      { key: '0', path: 'C:/data/ok.gif', name: 'ok.gif', status: 'added', message: '成功' },
      {
        key: '1',
        path: 'C:/data/locked.gif',
        name: 'locked.gif',
        status: 'failed',
        code: 'permission',
        message: '没有读取权限',
      },
    ],
  }),
  retryImport: async (id) => {
    operations.push({ type: 'retry-import', id });
    return { reportId: 'fixture-report' };
  },
  revealReportItem: resolved,
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
