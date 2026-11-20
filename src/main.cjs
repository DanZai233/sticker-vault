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
  utilityProcess,
  safeStorage,
} = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { Library } = require('./library.cjs');
const { Connectors } = require('./connectors.cjs');
const { DouyinConnector } = require('./douyin.cjs');
const native = require('./native.cjs');
const { StartupControl } = require('./startup.cjs');
const { OcrQueue } = require('./ocr.cjs');
const { OcrRunner } = require('./ocr-runner.cjs');
const { OcrImageExtractor } = require('./ocr-image.cjs');
const { Transfers } = require('./transfer.cjs');
const { readReport } = require('./import-diagnostics.cjs');
let win,
  lib,
  timer,
  connectors,
  douyin,
  tray,
  panel,
  targetPid = 0,
  quitting = false,
  scanning = false,
  ocr,
  imageExtractor,
  startupControl,
  transfers,
  startupState = { supported: false, enabled: false };
if (process.env.STICKER_TEST_ROOT) app.setPath('userData', process.env.STICKER_TEST_ROOT);
const ownsLock = app.requestSingleInstanceLock();
if (!ownsLock) app.quit();
app.on('second-instance', (_, argv) => {
  if (win && !argv.includes('--background')) {
    win.show();
    win.focus();
  }
  if (argv.includes('--connect-qq')) connectors?.qq();
  if (argv.includes('--connect-wechat')) connectors?.wechat();
});

const snapshot = () => {
  const { ocrRecords, ...data } = lib.data;
  return {
    ...data,
    platform: process.platform,
    startup: startupState,
    ocr: ocr?.summary(),
    transferState: transfers?.snapshot(),
    trash: (lib.data.trash || []).map((item) => ({
      ...item,
      url: pathToFileURL(path.join(lib.root, 'originals', item.file)).href,
    })),
    items: lib.data.items.map((i) => ({
      ...i,
      url: pathToFileURL(path.join(lib.root, 'originals', i.file)).href,
    })),
  };
};

const notify = () => {
  for (const w of [win, panel])
    if (w && !w.isDestroyed()) w.webContents.send('changed', snapshot());
};
function notifyItem(id, { move = false } = {}) {
  const item = lib.data.items.find((value) => value.id === id);
  if (!item) return;
  const update = {
    item: { ...item, url: pathToFileURL(path.join(lib.root, 'originals', item.file)).href },
    move,
  };
  for (const window of [win, panel])
    if (window && !window.isDestroyed()) window.webContents.send('item-update', update);
}
async function used(id) {
  if (!lib.data.items.some((item) => item.id === id)) return;
  const item = lib.data.items.find((item) => item.id === id);
  await lib.update(id, { lastUsedAt: Date.now(), useCount: (item.useCount || 0) + 1 });
  notifyItem(id);
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
  const item = lib.data.items.find((i) => i.id === id) || lib.data.trash?.find((i) => i.id === id);
  if (!item) throw Error('找不到表情');
  return path.join(lib.root, 'originals', item.file);
};
async function scan() {
  if (scanning) return;
  scanning = true;
  try {
    for (const folder of lib.data.folders) {
      try {
        const r = await lib.import([folder.path], folder.source, {
          restoreTrash: false,
          automatic: true,
        });
        folder.error = r.failed ? `${r.failed} 项读取失败，请查看诊断` : '';
        folder.lastResult = {
          added: r.added,
          duplicates: r.duplicates,
          skipped: r.skipped,
          failed: r.failed,
        };
        if (r.reportId) folder.lastReport = r.reportId;
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
    connectors = new Connectors(lib, notify, app.getPath('home'), process.platform, {
      documents: app.getPath('documents'),
      appData: app.getPath('appData'),
    });
    douyin = new DouyinConnector(connectors);
    startupControl = new StartupControl({ app });
    startupState = await startupControl.get();
    const backgroundLaunch =
      process.argv.includes('--background') ||
      (process.platform === 'darwin' && app.getLoginItemSettings().wasOpenedAtLogin);
    imageExtractor = new OcrImageExtractor();
    const runner = new OcrRunner({
      modelsPath: app.isPackaged
        ? path.join(process.resourcesPath, 'ocr-data')
        : path.join(__dirname, '../vendor/ocr-data'),
      hostPath: app.isPackaged
        ? path.join(process.resourcesPath, 'app.asar.unpacked/src/ocr-host.cjs')
        : path.join(__dirname, 'ocr-host.cjs'),
      spawnHost: (host) =>
        utilityProcess.fork(host, [], { serviceName: '表情仓后台 OCR', stdio: 'pipe' }),
    });
    ocr = await new OcrQueue(lib, {
      engine: runner,
      prepareImage: (file) => imageExtractor.read(file),
      notify: (summary, item) => {
        const update = {
          summary,
          item: item
            ? { ...item, url: pathToFileURL(path.join(lib.root, 'originals', item.file)).href }
            : undefined,
        };
        for (const window of [win, panel])
          if (window && !window.isDestroyed()) window.webContents.send('ocr-update', update);
      },
      schedule:
        !process.env.STICKER_SMOKE &&
        !process.env.STICKER_CONNECTOR_SMOKE &&
        !process.env.STICKER_GALLERY_SMOKE,
    }).init();
    transfers = await new Transfers(lib, {
      root: app.getPath('userData'),
      safeStorage,
      config: () => ({
        startupRequested: !!startupState.requested,
        webdav: transfers?.settings.config.url
          ? { url: transfers.settings.config.url, username: transfers.settings.config.username }
          : null,
      }),
      notify: (update) => {
        if (win && !win.isDestroyed()) win.webContents.send('transfer-update', update);
      },
      afterMerge: () => {
        if (lib.data.settings?.ocrEnabled !== false) ocr.arm(1000);
        else if (!ocr.running) ocr.engine.stop?.();
        notify();
      },
    }).init();
    ipcMain.handle('transfer-state', () => transfers.snapshot());
    ipcMain.handle('webdav-save', (_, input) => transfers.save(input));
    ipcMain.handle('webdav-forget', () => transfers.forget());
    ipcMain.handle('webdav-test', () => transfers.test());
    ipcMain.handle('webdav-sync', () => transfers.sync());
    ipcMain.on('transfer-cancel', () => transfers.cancel());
    ipcMain.handle('backup-export', async () => {
      const selected = await dialog.showSaveDialog(win, {
        title: '导出完整表情仓备份',
        defaultPath: 'StickerVault-backup-' + new Date().toISOString().slice(0, 10) + '.zip',
        filters: [{ name: '表情仓完整备份', extensions: ['zip'] }],
      });
      if (selected.canceled || !selected.filePath) return null;
      return transfers.export(selected.filePath);
    });
    ipcMain.handle('backup-import', async () => {
      const selected = await dialog.showOpenDialog(win, {
        title: '导入完整表情仓备份',
        properties: ['openFile'],
        filters: [{ name: '表情仓完整备份', extensions: ['zip'] }],
      });
      if (selected.canceled) return null;
      return transfers.import(selected.filePaths[0], async (manifest) => {
        const answer = await dialog.showMessageBox(win, {
          type: 'question',
          title: '合并备份',
          message: `备份含 ${manifest.items.length} 个表情，将合并到当前 ${lib.data.items.length} 个表情。`,
          detail:
            '保留现有原件，重复图片合并名称、标签、收藏和排序。不会传播删除。导入前保存本机配置恢复点；目录、平台登录和系统自启需要在本机重新配置。备份不包含密码或登录态。',
          buttons: ['取消', '合并导入'],
          defaultId: 1,
          cancelId: 0,
          checkboxLabel: '合并便携设置（如 OCR 开关）',
          checkboxChecked: true,
        });
        return answer.response === 1 ? { restoreSettings: answer.checkboxChecked } : null;
      });
    });
    ipcMain.handle('ocr-enabled', (_, enabled) => ocr.setEnabled(enabled));
    ipcMain.handle('startup-enabled', async (_, enabled) => {
      startupState = await startupControl.set(enabled);
      notify();
      return startupState;
    });
    ipcMain.handle('startup-settings', () => {
      if (process.platform === 'darwin')
        return shell.openExternal(
          'x-apple.systempreferences:com.apple.LoginItems-Settings.extension',
        );
      if (process.platform === 'win32') return shell.openExternal('ms-settings:startupapps');
      return shell.openPath(path.dirname(startupControl.file));
    });
    ipcMain.handle('wechat-cache-authorize', async () => {
      if (process.platform !== 'darwin') throw Error('当前平台不需要 macOS 缓存授权。');
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
      const defaultPath = await connectors.defaultDirectory(id);
      const d = await dialog.showOpenDialog(win, {
        title:
          process.platform === 'darwin'
            ? id === 'qq'
              ? '授权读取 QQ 个人收藏'
              : '授权读取微信收藏'
            : id === 'qq'
              ? '选择 QQ 数据目录'
              : '选择微信 4.x 数据目录',
        message:
          id === 'wechat'
            ? '请选择微信 4.x 的 xwechat_files 文件夹，或其中的账号文件夹。自定义位置可在微信设置 → 文件管理中查看。'
            : '请选择 QQ 的个人数据目录，仅用于读取表情原件。',
        buttonLabel: process.platform === 'darwin' ? '允许读取' : '选择此目录',
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
    ipcMain.handle('state', async () => {
      startupState = await startupControl.get();
      return snapshot();
    });
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
      notifyItem(id);
    });
    ipcMain.handle('move-to-front', async (_, id) => {
      await lib.moveToFront(id);
      notifyItem(id, { move: true });
    });
    ipcMain.handle('remove', async (_, ids) => {
      const result = await lib.remove(ids);
      notify();
      return result;
    });
    ipcMain.handle('trash-restore', async (_, ids) => {
      const result = await lib.restore(ids);
      notify();
      return result;
    });
    ipcMain.handle('trash-discard', async (_, ids) => {
      const count = (lib.data.trash || []).filter((item) => ids.includes(item.id)).length;
      if (!count) return { removed: 0, failed: [] };
      const answer = await dialog.showMessageBox(win, {
        type: 'question',
        message: `将 ${count} 个回收站表情交给系统废纸篓？`,
        detail: '从本应用回收站移除，原件交由系统废纸篓保管；不会自动永久删除文件。',
        buttons: ['取消', '移到系统废纸篓'],
        defaultId: 0,
        cancelId: 0,
      });
      if (answer.response !== 1) return { canceled: true };
      const result = await lib.discard(ids, (file) => shell.trashItem(file));
      notify();
      return result;
    });
    ipcMain.handle('import-report', (_, id) => readReport(lib, id));
    ipcMain.handle('import-retry', async (_, id) => {
      const report = await readReport(lib, id);
      const paths = report.details
        .filter((item) => item.status === 'failed')
        .map((item) => item.path);
      if (!paths.length) return null;
      const result = await lib.import(paths, report.source);
      notify();
      return result;
    });
    ipcMain.handle('report-reveal', async (_, id, key) => {
      const report = await readReport(lib, id);
      const item = report.details.find((item) => item.key === key);
      if (item) shell.showItemInFolder(item.path);
    });
    ipcMain.handle('reveal', (_, id) => shell.showItemInFolder(fileFor(id)));
    ipcMain.handle('copy-path', (_, id) => clipboard.writeText(fileFor(id)));
    ipcMain.handle('export', async (_, ids) => {
      const d = await dialog.showOpenDialog(win, {
        properties: ['openDirectory', 'createDirectory'],
      });
      if (d.canceled) return null;
      for (const id of ids) {
        const i =
          lib.data.items.find((x) => x.id === id) || lib.data.trash?.find((x) => x.id === id);
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
      } finally {
        if (!event.sender.isDestroyed()) event.sender.send('drag-ended');
      }
    });
    win = new BrowserWindow({
      width: 1240,
      height: 830,
      minWidth: 760,
      minHeight: 580,
      show: !backgroundLaunch && !process.env.STICKER_GALLERY_SMOKE,
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
    if (process.env.STICKER_GALLERY_SMOKE) await require('./desktop-smoke.cjs')({ app, win, lib });
    if (process.env.STICKER_SMOKE) {
      await require('./smoke.cjs')({ app, win, lib, snapshot, used, showPanel, fileFor, native });
    }
  });
app.on('activate', () => {
  if (win && !win.isDestroyed()) {
    win.show();
    win.focus();
  }
});
app.on('before-quit', () => {
  quitting = true;
  transfers?.cancel();
  ocr?.stop();
  imageExtractor?.stop();
});
app.on('window-all-closed', () => {
  if (!tray) app.quit();
});
app.on('will-quit', () => {
  clearInterval(timer);
  globalShortcut.unregisterAll();
});
