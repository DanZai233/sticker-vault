const { BrowserWindow, ipcMain } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const { collectedStickers, downloadSticker } = require('./connectors.cjs');
class DouyinConnector {
  constructor(connectors) {
    this.c = connectors;
    this.queue = Promise.resolve();
    ipcMain.on('douyin-collection', (event, data) => {
      if (
        !this.win ||
        this.win.isDestroyed() ||
        event.sender !== this.win.webContents ||
        !event.sender.getURL().startsWith('https://www.douyin.com/') ||
        !this.c.lib.data.connectors.douyin?.enabled
      )
        return;
      this.queue = this.queue
        .then(() => this.consume(data))
        .catch(async (e) => {
          this.c.status('douyin', { status: 'error', message: '读取收藏列表失败：' + e.message });
          await this.c.persist();
        });
    });
  }
  async open() {
    const c = this.c;
    c.status('douyin', {
      enabled: true,
      status: 'waiting',
      message: '请在抖音窗口登录，打开私信的收藏表情面板；向下滚动可收集更多。',
    });
    await c.persist();
    if (this.win && !this.win.isDestroyed()) {
      this.win.show();
      this.win.focus();
      return;
    }
    const win = (this.win = new BrowserWindow({
      width: 1100,
      height: 800,
      show: false,
      backgroundColor: '#f6f8f5',
      title: '抖音收藏自动导入 · 登录后打开收藏表情面板',
      webPreferences: {
        preload: path.join(__dirname, 'douyin-preload.cjs'),
        partition: 'persist:douyin-stickers',
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
      },
    }));
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', (e, url) => {
      try {
        const u = new URL(url);
        if (
          u.protocol !== 'https:' ||
          !(u.hostname === 'douyin.com' || u.hostname.endsWith('.douyin.com'))
        )
          e.preventDefault();
      } catch {
        e.preventDefault();
      }
    });
    win.webContents.setUserAgent(
      win.webContents
        .getUserAgent()
        .replace(/ Electron\/[^ ]+/g, '')
        .replace(/ StickerVault\/[^ ]+/g, ''),
    );
    let ready = false;
    const timeout = setTimeout(() => {
      if (win.isDestroyed() || ready) return;
      c.status('douyin', {
        status: 'error',
        message: '抖音页面加载超时，请检查网络后点击重新打开。',
      });
      win.destroy();
    }, 45000);
    win.webContents.once('dom-ready', () => {
      ready = true;
      clearTimeout(timeout);
      win.show();
      win.focus();
      win.setProgressBar(-1);
    });
    win.setProgressBar(0.3);
    win.webContents.on('did-fail-load', (_, code, description, url, isMain) => {
      if (isMain && code !== -3)
        c.status('douyin', {
          status: 'error',
          message: '抖音加载失败：' + description + '。请重试。',
        });
    });
    win.on('closed', () => {
      this.win = null;
      if (!c.lib.data.connectors.douyin?.enabled) return;
      c.status('douyin', {
        status: 'waiting',
        message: '导入窗口已关闭。再次打开并进入收藏表情面板可继续同步。',
      });
      c.persist();
    });
    win
      .loadURL('https://www.douyin.com/')
      .catch(() =>
        c.status('douyin', { status: 'error', message: '抖音页面加载失败，请检查网络后重试。' }),
      );
  }
  async consume(data) {
    const c = this.c;
    if (!c.lib.data.connectors.douyin?.enabled) return;
    const page = collectedStickers(data);
    c.status('douyin', {
      status: 'syncing',
      message: `收到 ${page.items.length} 个收藏，正在保存原件…`,
    });
    const out = path.join(c.lib.root, 'connector-cache/douyin');
    await fs.mkdir(out, { recursive: true });
    let added = 0,
      failed = 0,
      animationFailures = 0;
    const seen = (c.lib.data.autoSeen.douyin ??= {});
    for (const item of page.items) {
      if (!c.lib.data.connectors.douyin?.enabled) break;
      const key = item.id || item.url;
      if (seen[key]) continue;
      const name = require('node:crypto').createHash('sha256').update(key).digest('hex');
      const dest = path.join(out, name);
      try {
        await downloadSticker(item.url, dest, item.animated);
        const r = await c.lib.import([dest], '抖音', { restoreTrash: false, automatic: true });
        if (r.errors.length) throw Error('导入失败');
        added += r.added;
        seen[key] = true;
      } catch (e) {
        failed++;
        if (/动画/.test(e.message)) animationFailures++;
      } finally {
        await fs.unlink(dest).catch(() => {});
      }
    }
    if (!c.lib.data.connectors.douyin?.enabled) return;
    c.status('douyin', {
      lastScan: Date.now(),
      status: failed ? 'partial' : 'ready',
      message: `本页新增 ${added} 个${failed ? ' · 失败 ' + failed + ' 个' : ''}${animationFailures ? '（含 ' + animationFailures + ' 个未取得动画原件）' : ''}。${page.hasMore ? '继续向下滚动收藏面板可导入更多。' : '已处理本次加载的收藏列表。'}`,
    });
    await c.persist();
  }
  close() {
    if (this.win && !this.win.isDestroyed()) this.win.close();
  }
}
module.exports = { DouyinConnector };
