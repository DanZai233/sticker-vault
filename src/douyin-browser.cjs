// A dedicated browser profile; never attach to an existing personal browser session.
const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { EventEmitter } = require('node:events');
const { observeCollections } = require('./douyin-network.cjs');
function browserCandidates(platform = process.platform, env = process.env) {
  if (platform === 'darwin')
    return [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    ];
  if (platform === 'win32')
    return [env.PROGRAMFILES, env['PROGRAMFILES(X86)'], env.LOCALAPPDATA]
      .filter(Boolean)
      .flatMap((base) => [
        path.win32.join(base, 'Google/Chrome/Application/chrome.exe'),
        path.win32.join(base, 'Microsoft/Edge/Application/msedge.exe'),
      ]);
  return [
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/microsoft-edge',
    '/usr/bin/microsoft-edge-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/snap/bin/chromium',
  ];
}
class DebugConnection extends EventEmitter {
  constructor(socket) {
    super();
    this.socket = socket;
    this.next = 0;
    this.pending = new Map();
    socket.addEventListener('message', (event) => {
      try {
        if (typeof event.data !== 'string' || event.data.length > 24 * 1024 * 1024) return;
        const data = JSON.parse(event.data);
        if (data.id) {
          const p = this.pending.get(data.id);
          if (!p) return;
          this.pending.delete(data.id);
          clearTimeout(p.timer);
          if (data.error) p.reject(Error('浏览器操作失败'));
          else p.resolve(data.result);
        } else if (data.method) this.emit('message', {}, data.method, data.params || {});
      } catch {}
    });
    socket.addEventListener('close', () => {
      for (const p of this.pending.values()) {
        clearTimeout(p.timer);
        p.reject(Error('采集浏览器已断开'));
      }
      this.pending.clear();
      this.emit('detach');
    });
  }
  attach() {}
  isAttached() {
    return this.socket.readyState === 1;
  }
  detach() {
    this.socket.close();
  }
  sendCommand(method, params = {}) {
    if (!this.isAttached()) return Promise.reject(Error('采集浏览器已断开'));
    const id = ++this.next;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(Error('浏览器操作超时'));
      }, 10000);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }
}
async function connectSocket(url) {
  const socket = new WebSocket(url);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.close();
      reject(Error('无法连接采集浏览器'));
    }, 5000);
    socket.addEventListener(
      'open',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
    socket.addEventListener(
      'error',
      () => {
        clearTimeout(timer);
        reject(Error('无法连接采集浏览器'));
      },
      { once: true },
    );
  });
  return socket;
}
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function openBrowserCollector({
  profile,
  onCollection,
  onError,
  onClose,
  executable,
  extraArgs = [],
  initialURL = 'https://www.douyin.com/?recommend=1',
  signal,
}) {
  if (!executable) {
    for (const candidate of browserCandidates()) {
      try {
        await fs.access(candidate);
        executable = candidate;
        break;
      } catch {}
    }
  }
  if (!executable) throw Error('未找到 Chrome 或 Edge。请从其官方网站安装后重试。');
  await fs.mkdir(profile, { recursive: true, mode: 0o700 });
  const portFile = path.join(profile, 'DevToolsActivePort');
  await fs.unlink(portFile).catch(() => {});
  const child = spawn(
    executable,
    [
      '--user-data-dir=' + profile,
      '--remote-debugging-address=127.0.0.1',
      '--remote-debugging-port=0',
      '--no-first-run',
      '--no-default-browser-check',
      ...extraArgs,
      'about:blank',
    ],
    { stdio: 'ignore', windowsHide: false },
  );
  let exited = false,
    closed = false,
    debug,
    stop = () => {};
  child.once('error', () => {
    exited = true;
  });
  child.once('exit', () => {
    exited = true;
    close();
  });
  const close = () => {
    process.removeListener('exit', close);
    signal?.removeEventListener('abort', close);
    if (closed) return;
    closed = true;
    stop();
    // This process owns only the isolated profile; never terminate the user's normal browser.
    child.kill();
    onClose?.();
  };
  process.once('exit', close);
  signal?.addEventListener('abort', close, { once: true });
  if (signal?.aborted) close();
  try {
    let port;
    const deadline = Date.now() + 15000;
    while (!port) {
      if (closed || exited || Date.now() > deadline)
        throw Error('独立浏览器未能启动，请关闭其他采集浏览器后重试。');
      try {
        const raw = (await fs.readFile(portFile, 'utf8')).split('\n')[0];
        if (/^\d+$/.test(raw) && +raw > 0 && +raw < 65536) port = +raw;
      } catch {}
      if (!port) await delay(100);
    }
    const endpoint = 'http://127.0.0.1:' + port;
    const response = await fetch(endpoint + '/json/list', { signal: AbortSignal.timeout(5000) });
    const pages = await response.json();
    const page = pages.find((p) => p.type === 'page' && p.url === 'about:blank');
    const ws = new URL(page?.webSocketDebuggerUrl);
    if (
      ws.protocol !== 'ws:' ||
      ws.hostname !== '127.0.0.1' ||
      +ws.port !== port ||
      !ws.pathname.startsWith('/devtools/page/')
    )
      throw Error('采集浏览器地址校验失败');
    debug = new DebugConnection(await connectSocket(ws.href));
    const contents = new EventEmitter();
    contents.debugger = debug;
    stop = await observeCollections(contents, onCollection, onError);
    await debug.sendCommand('Page.enable');
    await debug.sendCommand('Page.navigate', { url: initialURL });
    await debug.sendCommand('Page.bringToFront');
    if (closed || exited) throw Error('采集浏览器已关闭');
    return { close, focus: () => debug.sendCommand('Page.bringToFront'), debug };
  } catch (error) {
    close();
    if (debug?.isAttached()) debug.detach();
    throw error;
  }
}
module.exports = { browserCandidates, DebugConnection, openBrowserCollector };
