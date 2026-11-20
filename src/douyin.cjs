const { BrowserWindow, WebContentsView, ipcMain, dialog, shell } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const { collectedStickers, downloadSticker } = require('./connectors.cjs');
const { observeCollections, trustedNavigation } = require('./douyin-network.cjs');
const { openBrowserCollector } = require('./douyin-browser.cjs');
const HOME = 'https://www.douyin.com/';
const BAR_HEIGHT = 118;
class DouyinConnector {
  constructor(connectors) {
    this.c = connectors;
    this.queue = Promise.resolve();
    ipcMain.handle('douyin-window-action', async (event, action) => {
      const win = this.win;
      if (!win || win.isDestroyed() || event.sender !== win.webContents) return;
      const wc = this.view.webContents;
      if (action === 'collect-browser') return this.openBrowser();
      if (action === 'refresh') return wc.reload();
      if (action === 'browser') return shell.openExternal(HOME);
      if (action !== 'reset') return;
      const answer = await dialog.showMessageBox(win, {
        type: 'question',
        buttons: ['取消', '重置并重新打开'],
        defaultId: 0,
        cancelId: 0,
        message: '重置抖音导入窗口的登录会话？',
        detail:
          '仅清除本应用抖音窗口的 Cookie 和网站缓存，需要重新登录。已有表情、系统浏览器和抖音客户端不受影响。',
      });
      if (answer.response !== 1 || wc.isDestroyed()) return;
      await wc.loadURL('about:blank');
      await wc.session.clearStorageData();
      await wc.session.clearCache();
      if (!wc.isDestroyed()) await wc.loadURL(HOME);
    });
  }
  async open() {
    const c = this.c;
    if (c.lib.data.connectors.douyin?.browserMode === 'external') return this.openBrowser();
    c.status('douyin', {
      enabled: true,
      status: 'waiting',
      message:
        '在导入窗口登录后，打开私信收藏表情面板。登录失败可刷新或重置会话；官网仍可能限制内置窗口登录。',
    });
    await c.persist();
    if (this.win && !this.win.isDestroyed()) {
      this.win.show();
      this.win.focus();
      return;
    }
    const win = (this.win = new BrowserWindow({
      width: 1100,
      height: 880,
      minWidth: 800,
      minHeight: 600,
      backgroundColor: '#f6f8f5',
      title: '抖音收藏导入',
      webPreferences: {
        preload: path.join(__dirname, 'douyin-shell-preload.cjs'),
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
      },
    }));
    const view = (this.view = new WebContentsView({
      webPreferences: {
        partition: 'persist:douyin-stickers',
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
      },
    }));
    win.contentView.addChildView(view);
    const layout = () => {
      const [width, height] = win.getContentSize();
      view.setBounds({ x: 0, y: BAR_HEIGHT, width, height: Math.max(0, height - BAR_HEIGHT) });
    };
    layout();
    win.on('resize', layout);
    const wc = view.webContents;
    const children = new Set();
    const protect = (contents) => {
      for (const event of ['will-navigate', 'will-redirect']) {
        contents.on(event, (e, url) => {
          if (!trustedNavigation(url)) e.preventDefault();
        });
      }
      contents.setWindowOpenHandler(({ url }) =>
        trustedNavigation(url)
          ? {
              action: 'allow',
              overrideBrowserWindowOptions: {
                parent: win,
                width: 900,
                height: 740,
                webPreferences: {
                  partition: 'persist:douyin-stickers',
                  nodeIntegration: false,
                  contextIsolation: true,
                  sandbox: true,
                },
              },
            }
          : { action: 'deny' },
      );
      contents.on('did-create-window', (child) => {
        children.add(child);
        protect(child.webContents);
        child.on('closed', () => children.delete(child));
      });
    };
    protect(wc);
    const notify = (message) => {
      if (!win.isDestroyed()) win.webContents.send('douyin-window-status', message);
    };
    let timer;
    let stop = () => {};
    win.on('closed', () => {
      clearTimeout(timer);
      stop();
      for (const child of children) if (!child.isDestroyed()) child.destroy();
      if (!wc.isDestroyed()) wc.close();
      this.win = null;
      this.view = null;
      if (this.browser || this.browserOpening) return;
      if (!c.lib.data.connectors.douyin?.enabled) return;
      c.status('douyin', {
        status: 'waiting',
        message: '导入窗口已关闭。再次打开并进入收藏表情面板可继续收集。',
      });
      c.persist().catch(() => {});
    });
    await wc.loadURL('about:blank');
    if (win.isDestroyed()) return;
    stop = await observeCollections(
      wc,
      (data) => {
        if (!c.lib.data.connectors.douyin?.enabled) return;
        notify('已收到收藏列表，正在导入原件。继续滚动收藏面板可加载更多。');
        this.queue = this.queue
          .then(() => this.consume(data))
          .catch(async () => {
            c.status('douyin', {
              status: 'error',
              message: '读取收藏列表失败，请重新打开收藏表情面板。',
            });
            await c.persist();
          });
      },
      () => {
        notify('收藏监听失败，请关闭此窗口后重新打开。');
        c.status('douyin', {
          status: 'error',
          message: '收藏监听失败，请关闭导入窗口后重新打开。',
        });
        c.persist().catch(() => {});
      },
    );
    if (win.isDestroyed()) {
      stop();
      return;
    }
    wc.on('did-start-loading', () => {
      clearTimeout(timer);
      if (this.browser || this.browserOpening) return;
      notify('正在加载抖音官网…');
      timer = setTimeout(
        () => notify('网页加载较慢。可刷新重试，或在系统浏览器检查官网能否登录。'),
        45000,
      );
    });
    wc.on('did-stop-loading', () => {
      clearTimeout(timer);
      if (this.browser || this.browserOpening) return;
      notify('请先登录，再打开私信中的收藏表情面板。若扫码、验证码均失败，请重置会话后重试。');
    });
    wc.on('did-fail-load', (_, code, description, url, main) => {
      if (main && code !== -3) {
        const message = '抖音页面加载失败（' + code + '），请检查网络后刷新。';
        notify(message);
        c.status('douyin', { status: 'error', message });
        c.persist().catch(() => {});
      }
    });
    await win.loadFile(path.join(__dirname, 'douyin-shell.html'));
    wc.loadURL(HOME).catch(() => {});
  }
  enqueue(data) {
    if (!this.c.lib.data.connectors.douyin?.enabled) return;
    this.queue = this.queue
      .then(() => this.consume(data))
      .catch(async () => {
        this.c.status('douyin', {
          status: 'error',
          message: '读取收藏列表失败，请重新打开收藏表情面板。',
        });
        await this.c.persist();
      });
  }
  async openBrowser() {
    if (this.browser) {
      const browser = this.browser;
      try {
        return await browser.focus();
      } catch {
        await browser.close();
        this.browser = null;
      }
    }
    if (this.browserOpening) return this.browserOpening;
    const c = this.c;
    this.browserController = new AbortController();
    this.browserOpening = (async () => {
      try {
        c.status('douyin', {
          enabled: true,
          status: 'waiting',
          message: '正在打开独立 Chrome / Edge 采集窗口…',
        });
        await c.persist();
        this.browser = await openBrowserCollector({
          profile: path.join(c.lib.root, 'connector-cache/douyin-browser'),
          signal: this.browserController.signal,
          onCollection: (data) => this.enqueue(data),
          onError: () => {
            c.status('douyin', {
              status: 'error',
              message: '独立浏览器采集连接已断开，请关闭并重新打开采集浏览器。',
            });
            c.persist().catch(() => {});
          },
          onClose: () => {
            this.browser = null;
            if (!c.lib.data.connectors.douyin?.enabled) return;
            c.status('douyin', {
              status: 'waiting',
              message: '独立采集浏览器已关闭。再次打开后可继续收集。',
            });
            c.persist().catch(() => {});
          },
        });
        c.status('douyin', {
          browserMode: 'external',
          status: 'waiting',
          message:
            '请在独立 Chrome / Edge 窗口登录，打开消息中的收藏表情面板并滚动。该窗口正在监听收藏响应；登录资料与日常浏览器分开保存。',
        });
        await c.persist();
      } catch (error) {
        c.status('douyin', { status: 'error', message: error.message });
        await c.persist();
        throw error;
      } finally {
        this.browserOpening = null;
      }
    })();
    return this.browserOpening;
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
    this.browserController?.abort();
    this.browser?.close();
  }
}
module.exports = { DouyinConnector };
