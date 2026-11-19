const {
  app,
  BrowserWindow,
  ipcMain,
  dialog,
  shell,
  nativeImage,
  globalShortcut,
  clipboard,
  Tray,
  Menu,
  screen,
} = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { Library } = require('./library.cjs');
const { Connectors } = require('./connectors.cjs');
const { DouyinConnector } = require('./douyin.cjs');
const native = require('./native.cjs');
let win,
  lib,
  timer,
  connectors,
  douyin,
  tray,
  panel,
  targetPid = 0,
  quitting = false,
  scanning = false;
if (process.env.STICKER_TEST_ROOT) app.setPath('userData', process.env.STICKER_TEST_ROOT);
const ownsLock = app.requestSingleInstanceLock();
if (!ownsLock) app.quit();
app.on('second-instance', (_, argv) => {
  if (win) {
    win.show();
    win.focus();
  }
  if (argv.includes('--connect-qq')) connectors?.qq();
  if (argv.includes('--connect-wechat')) connectors?.wechat();
});

const snapshot = () => ({
  ...lib.data,
  items: lib.data.items.map((i) => ({
    ...i,
    url: pathToFileURL(path.join(lib.root, 'originals', i.file)).href,
  })),
});
const notify = () => {
  for (const w of [win, panel])
    if (w && !w.isDestroyed()) w.webContents.send('changed', snapshot());
};
async function used(id) {
  const item = lib.data.items.find((i) => i.id === id);
  if (item) await lib.update(id, { lastUsedAt: Date.now(), useCount: (item.useCount || 0) + 1 });
  notify();
}
async function showPanel() {
  targetPid = await native.frontmost().catch(() => 0);
  if (!panel) {
    panel = new BrowserWindow({
      width: 404,
      height: 585,
      show: false,
      frame: false,
      resizable: false,
      alwaysOnTop: true,
      skipTaskbar: true,
      webPreferences: {
        preload: path.join(__dirname, 'preload.cjs'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    panel.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    panel.webContents.on('will-navigate', (e) => e.preventDefault());
    panel.on('blur', () => panel?.hide());
    await panel.loadFile(path.join(__dirname, 'panel.html'));
  }
  const b = tray.getBounds(),
    area = screen.getDisplayMatching(b).workArea;
  panel.setPosition(
    Math.min(Math.max(b.x - 180, area.x), area.x + area.width - 404),
    process.platform === 'darwin' ? b.y + b.height + 6 : Math.max(area.y, b.y - 585),
  );
  panel.show();
  panel.focus();
  return panel;
}

const fileFor = (id) => {
  const item = lib.data.items.find((i) => i.id === id);
  if (!item) throw Error('找不到表情');
  return path.join(lib.root, 'originals', item.file);
};
async function scan() {
  if (scanning) return;
  scanning = true;
  try {
    for (const folder of lib.data.folders) {
      try {
        const r = await lib.import([folder.path], folder.source);
        folder.error = '';
        folder.lastScan = Date.now();
        if (r.added) notify();
      } catch (e) {
        folder.error = e.message;
      }
    }
    await lib.run(() => lib.save());
    if (connectors) await connectors.tick();
    notify();
  } finally {
    scanning = false;
  }
}
if (ownsLock)
  app.whenReady().then(async () => {
    lib = await new Library(path.join(app.getPath('userData'), 'vault')).init();
    connectors = new Connectors(lib, notify);
    douyin = new DouyinConnector(connectors);
    ipcMain.handle('wechat-cache-authorize', async () => {
      const d = await dialog.showOpenDialog(win, {
        title: '授权微信助手缓存',
        message: '允许读取并更新微信助手的本地缓存目录。这个目录不包含聊天记录。',
        defaultPath: path.join(
          app.getPath('home'),
          'Library/Containers/com.tencent.xinWeChat/Data/Documents/export-wechat-emoji',
        ),
        buttonLabel: '允许助手缓存',
        properties: ['openDirectory'],
      });
      if (!d.canceled) return connectors.wechat();
    });
    ipcMain.handle('connector-authorize', async (_, id) => {
      if (!['qq', 'wechat'].includes(id)) throw Error('未知来源');
      const defaultPath = path.join(
        app.getPath('home'),
        id === 'qq'
          ? 'Library/Containers/com.tencent.qq/Data/Library/Application Support/QQ'
          : 'Library/Containers/com.tencent.xinWeChat/Data/Documents/xwechat_files',
      );
      const d = await dialog.showOpenDialog(win, {
        title: id === 'qq' ? '授权读取 QQ 个人收藏' : '授权读取微信收藏',
        message: '选择当前打开的数据文件夹并点击「允许读取」。仅用于读取个人表情原件。',
        buttonLabel: '允许读取',
        defaultPath,
        properties: ['openDirectory'],
      });
      if (d.canceled) return;
      connectors.status(id, { base: d.filePaths[0] });
      await connectors.persist();
      return id === 'qq' ? connectors.qq() : connectors.wechat();
    });
    ipcMain.handle('connector-sync', async (_, id, account) => {
      if (id === 'qq') return connectors.qq();
      if (id === 'wechat') return connectors.wechat(account);
      if (id === 'douyin') return douyin.open();
      throw Error('未知来源');
    });
    ipcMain.handle('connector-disable', async (_, id) => {
      if (!['qq', 'wechat', 'douyin'].includes(id)) throw Error('未知来源');
      await connectors.disable(id);
      if (id === 'douyin') douyin.close();
    });
    ipcMain.handle('state', () => snapshot());
    ipcMain.handle('copy-original', async (_, id) => {
      const r = await native.insert(fileFor(id), 0);
      await used(id);
      return r;
    });
    ipcMain.handle('insert', async (_, id) => {
      const file = fileFor(id);
      panel?.hide();
      const r = await native.insert(file, targetPid);
      await used(id);
      if (!r.pasted && win && !win.isDestroyed())
        win.webContents.send(
          'error',
          '已复制原文件，请回到聊天窗口按 ⌘V / Ctrl+V。自动粘贴需辅助功能权限。',
        );
      return r;
    });
    ipcMain.handle('authorize-paste', () => native.authorize());
    ipcMain.on('open-main', () => {
      panel?.hide();
      win.show();
      win.focus();
    });
    ipcMain.handle('import', async (_, paths) => {
      if (!paths) {
        const d = await dialog.showOpenDialog(win, {
          properties: ['openFile', 'multiSelections'],
          filters: [{ name: '图片与动图', extensions: ['gif', 'png', 'jpg', 'jpeg', 'webp'] }],
        });
        if (d.canceled) return null;
        paths = d.filePaths;
      }
      const r = await lib.import(paths);
      notify();
      return r;
    });
    ipcMain.handle('update', async (_, id, p) => {
      const patch = {};
      if (typeof p.name === 'string') patch.name = p.name.slice(0, 200);
      if (Array.isArray(p.tags))
        patch.tags = p.tags
          .filter((t) => typeof t === 'string')
          .map((t) => t.slice(0, 40))
          .slice(0, 20);
      if (typeof p.favorite === 'boolean') patch.favorite = p.favorite;
      await lib.update(id, patch);
      notify();
    });
    ipcMain.handle('remove', async (_, ids) => {
      const r = await dialog.showMessageBox(win, {
        type: 'question',
        message: `从素材库移除 ${ids.length} 个表情？`,
        detail: '原始导入文件不受影响；已关联的文件夹再次扫描时可能重新导入。',
        buttons: ['取消', '移除'],
        defaultId: 0,
        cancelId: 0,
      });
      if (r.response === 1) {
        await lib.remove(ids);
        notify();
      }
    });
    ipcMain.handle('reveal', (_, id) => shell.showItemInFolder(fileFor(id)));
    ipcMain.handle('copy-path', (_, id) => clipboard.writeText(fileFor(id)));
    ipcMain.handle('export', async (_, ids) => {
      const d = await dialog.showOpenDialog(win, {
        properties: ['openDirectory', 'createDirectory'],
      });
      if (d.canceled) return null;
      for (const id of ids) {
        const i = lib.data.items.find((x) => x.id === id);
        if (!i) continue;
        await fs.copyFile(
          fileFor(id),
          path.join(
            d.filePaths[0],
            i.name.replace(/[/\\:*?"<>|]/g, '_') + '-' + id.slice(0, 8) + '.' + i.ext,
          ),
        );
      }
      return ids.length;
    });
    ipcMain.handle('folder-add', async (_, source) => {
      const d = await dialog.showOpenDialog(win, { properties: ['openDirectory'] });
      if (d.canceled) return;
      await lib.run(async () => {
        if (!lib.data.folders.some((f) => f.path === d.filePaths[0]))
          lib.data.folders.push({ path: d.filePaths[0], source });
        await lib.save();
      });
      await scan();
    });
    ipcMain.handle('folder-remove', async (_, p) => {
      await lib.run(async () => {
        lib.data.folders = lib.data.folders.filter((f) => f.path !== p);
        await lib.save();
      });
      notify();
    });
    ipcMain.handle('scan', scan);
    ipcMain.on('drag', (event, id) => {
      try {
        const file = fileFor(id);
        const icon = nativeImage.createFromPath(path.join(__dirname, '../assets/icon.png'));
        event.sender.startDrag({
          file,
          icon: icon.isEmpty() ? nativeImage.createEmpty() : icon.resize({ width: 64, height: 64 }),
        });
        used(id).catch(() => {});
      } catch (e) {
        event.sender.send('error', '拖出失败：' + e.message);
      }
    });
    win = new BrowserWindow({
      width: 1240,
      height: 830,
      minWidth: 760,
      minHeight: 580,
      title: '表情仓',
      backgroundColor: '#f7f8fa',
      webPreferences: {
        preload: path.join(__dirname, 'preload.cjs'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', (e) => e.preventDefault());
    await win.loadFile(path.join(__dirname, 'index.html'));
    const trayIcon = nativeImage.createFromPath(path.join(__dirname, '../assets/tray.png'));
    trayIcon.setTemplateImage(process.platform === 'darwin');
    tray = new Tray(trayIcon);
    tray.setToolTip('表情仓 · 快捷表情');
    tray.on('click', () => {
      if (panel?.isVisible()) panel.hide();
      else showPanel().catch((e) => win.webContents.send('error', e.message));
    });
    tray.on('right-click', () =>
      tray.popUpContextMenu(
        Menu.buildFromTemplate([
          {
            label: '打开素材库',
            click: () => {
              win.show();
              win.focus();
            },
          },
          { label: '快捷表情', click: () => showPanel() },
          { type: 'separator' },
          { label: '退出表情仓', click: () => app.quit() },
        ]),
      ),
    );
    win.on('close', (e) => {
      if (!quitting && !process.env.STICKER_SMOKE && !process.env.STICKER_CONNECTOR_SMOKE) {
        e.preventDefault();
        win.hide();
      }
    });
    globalShortcut.register('CommandOrControl+Shift+E', () => showPanel().catch(() => {}));
    timer = setInterval(scan, 30000);
    scan();
    if (process.argv.includes('--connect-qq')) connectors.qq();
    if (process.argv.includes('--authorize-connectors')) {
      win.webContents
        .executeJavaScript(
          "document.querySelector('#manage').click();window.vault.authorizeConnector('qq').then(()=>window.vault.authorizeConnector('wechat'))",
        )
        .catch(() => {});
    }
    if (process.argv.includes('--connect-wechat')) connectors.wechat();
    if (process.env.STICKER_CONNECTOR_SMOKE) {
      await require('./connector-smoke.cjs')({ app, win, lib, connectors, snapshot });
    }
    if (process.env.STICKER_SMOKE) {
      await require('./smoke.cjs')({ app, win, lib, snapshot, used, showPanel, fileFor, native });
    }
  });
app.on('before-quit', () => {
  quitting = true;
});
app.on('window-all-closed', () => {
  if (!tray) app.quit();
});
app.on('will-quit', () => {
  clearInterval(timer);
  globalShortcut.unregisterAll();
});
