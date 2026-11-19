const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { identify } = require('./library.cjs');
async function dirs(p) {
  try {
    return (await fs.readdir(p, { withFileTypes: true }))
      .filter((d) => d.isDirectory() && !d.isSymbolicLink())
      .map((d) => path.join(p, d.name));
  } catch (e) {
    if (e.code === 'ENOENT') return [];
    throw e;
  }
}
async function discoverQQ(home = os.homedir(), platform = process.platform, override) {
  const bases = override
    ? [override]
    : platform === 'darwin'
      ? [path.join(home, 'Library/Containers/com.tencent.qq/Data/Library/Application Support/QQ')]
      : platform === 'win32'
        ? [
            path.join(home, 'Documents/Tencent Files'),
            path.join(home, 'AppData/Roaming/Tencent/QQ'),
          ]
        : [path.join(home, '.config/QQ')];
  const out = [];
  for (const base of bases) {
    for (const user of await dirs(base)) {
      const name = path.basename(user);
      if (!/^nt_qq_|^\d+$/.test(name)) continue;
      for (const rel of [
        'nt_data/Emoji/personal_emoji/Ori',
        'nt_qq/nt_data/Emoji/personal_emoji/Ori',
      ]) {
        const root = path.join(user, rel);
        try {
          if ((await fs.stat(root)).isDirectory()) out.push(root);
        } catch (e) {
          if (e.code !== 'ENOENT') throw e;
        }
      }
    }
  }
  return out;
}
async function wechatAccounts(home = os.homedir(), override) {
  return (
    await dirs(
      override ||
        path.join(home, 'Library/Containers/com.tencent.xinWeChat/Data/Documents/xwechat_files'),
    )
  )
    .filter((p) => path.basename(p).startsWith('wxid_'))
    .map((p) => path.basename(p));
}
class Connectors {
  constructor(lib, notify, home = os.homedir(), platform = process.platform) {
    this.platform = platform;
    this.lib = lib;
    this.notify = notify;
    this.home = home;
    this.busy = new Set();
    lib.data.connectors ??= {};
    lib.data.autoSeen ??= {};
    for (const c of Object.values(lib.data.connectors)) {
      if (c.status === 'syncing') {
        c.status = 'waiting';
        c.message = '上次读取中断，请重试。';
      }
    }
  }
  status(id, patch) {
    Object.assign((this.lib.data.connectors[id] ??= { enabled: false }), patch);
    this.notify();
  }
  async persist() {
    await this.lib.run(() => this.lib.save());
  }
  async qq() {
    if (this.busy.has('qq')) return;
    this.busy.add('qq');
    this.status('qq', { enabled: true, status: 'syncing', message: '查找 QQ 个人收藏原件…' });
    try {
      const roots = await discoverQQ(this.home, this.platform, this.lib.data.connectors.qq?.base);
      if (!roots.length) {
        this.status('qq', {
          status: 'waiting',
          message: '未找到 QQ 个人收藏缓存。请先登录 QQ，打开收藏表情面板后重试。',
        });
        return;
      }
      const changed = [];
      const seen = (this.lib.data.autoSeen.qq ??= {});
      for (const p of await this.lib.collect(roots)) {
        const st = await fs.stat(p);
        const sig = st.size + ':' + st.mtimeMs;
        if (seen[p] !== sig) changed.push({ p, sig });
      }
      const r = changed.length
        ? await this.lib.import(
            changed.map((f) => f.p),
            'QQ',
          )
        : { added: 0, duplicates: 0, skipped: 0, errors: [] };
      if (!r.errors.length) for (const f of changed) seen[f.p] = f.sig;
      this.status('qq', {
        status: r.errors.length ? 'partial' : 'ready',
        lastScan: Date.now(),
        message: `${roots.length} 个账号缓存 · 本次新增 ${r.added} 个 · 忽略重复 ${r.duplicates} 个${r.errors.length ? ' · 部分文件读取失败' : ''}`,
        total: this.lib.data.items.filter((i) => i.source === 'QQ').length,
      });
    } catch (e) {
      this.status('qq', {
        status: ['EPERM', 'EACCES'].includes(e.code) ? 'permission' : 'error',
        message: ['EPERM', 'EACCES'].includes(e.code)
          ? 'macOS 尚未允许读取 QQ 目录，请点「授权目录」选择 QQ 数据文件夹。'
          : 'QQ 读取失败：' + e.message,
      });
    } finally {
      this.busy.delete('qq');
      await this.persist();
    }
  }
  async wechat(account) {
    if (this.busy.has('wechat')) return;
    let accounts;
    try {
      accounts = await wechatAccounts(this.home, this.lib.data.connectors.wechat?.base);
    } catch (e) {
      this.status('wechat', {
        enabled: true,
        status: 'permission',
        message: 'macOS 尚未允许读取微信目录，请点「授权目录」选择 xwechat_files。',
      });
      await this.persist();
      return;
    }
    if (!account && accounts.length === 1) account = accounts[0];
    if (!accounts.includes(account)) {
      this.status('wechat', {
        enabled: true,
        status: 'waiting',
        message: accounts.length
          ? '请在下方选择微信账号后重试。'
          : '未发现微信账号，请先登录电脑版微信。',
        accounts,
      });
      await this.persist();
      return;
    }
    const helper = __dirname.includes(path.sep + 'app.asar' + path.sep)
      ? path.join(__dirname, '../../wxemoticon/wxemoticon')
      : path.join(__dirname, '../vendor/wxemoticon/wxemoticon');
    if (process.platform !== 'darwin') {
      this.status('wechat', {
        enabled: true,
        status: 'error',
        message: '当前微信助手仅随 macOS 版本提供。',
      });
      return;
    }
    this.busy.add('wechat');
    this.status('wechat', {
      enabled: true,
      status: 'syncing',
      waitingForExit: false,
      account,
      accounts,
      message: '首次需要退出原微信；如弹出微信副本，请登录并打开表情面板。',
    });
    await this.persist();
    const out = path.join(this.lib.root, 'connector-cache/wechat', account);
    await fs.mkdir(out, { recursive: true });
    const cached = await this.lib.import([out], '微信');
    if (cached.added) this.notify();
    try {
      await fs.access(helper, require('node:fs').constants.X_OK);
    } catch {
      this.busy.delete('wechat');
      this.status('wechat', {
        status: 'error',
        message: '微信助手不可执行，请重新安装最新版应用。',
      });
      await this.persist();
      return;
    }
    const child = spawn(
      helper,
      [
        '--no-interactive',
        ...(this.lib.data.connectors.wechat?.base
          ? ['--wechat-data-dir', this.lib.data.connectors.wechat.base]
          : []),
        'export',
        '--wxid',
        account,
        '--out-dir',
        out,
        '--flat',
        '--skip-existing',
        '--json',
        '--timeout',
        '180',
        '--http-timeout',
        '20',
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    this.wechatChild = child;
    let stderr = '';
    let stdout = '';
    child.stdout.on('data', (b) => {
      stdout = (stdout + b.toString()).slice(-32768);
    });
    child.stderr.on('data', (b) => {
      stderr = (stderr + b.toString()).slice(-6000);
      const safe = stderr.replace(/[a-fA-F0-9]{32,}/g, '[redacted]');
      fs.writeFile(path.join(out, 'import.log'), safe).catch(() => {});
      if (/已生成 URL/.test(safe))
        this.status('wechat', { message: '已读取收藏列表，正在下载表情原件，请稍候…' });
      else if (/启动微信副本|等待.*key/.test(safe))
        this.status('wechat', { message: '请在打开的微信副本中登录，并打开一次表情面板。' });
      else if (/准备 WeChat 副本|重签名/.test(safe))
        this.status('wechat', { message: '正在准备微信副本，首次可能需要一分钟…' });
    });
    const finish = async (code, error) => {
      if (!this.busy.has('wechat')) return;
      try {
        const result = await this.lib.import([out], '微信');
        const r = { ...result, added: result.added + cached.added };
        const permission = /Operation not permitted|Permission denied|不允许|权限/i.test(stderr);
        const waiting = /退出|WECHAT_RUNNING|running|微信.*运行/i.test(stderr);
        const timeout = /超时|timeout/i.test(stderr);
        const cachePermission = permission && /缓存目录/.test(stderr);
        let failed = 0;
        try {
          failed = Number(JSON.parse(stdout).failed) || 0;
        } catch {}
        this.status('wechat', {
          status:
            code === 0
              ? failed
                ? 'partial'
                : 'ready'
              : r.added
                ? 'partial'
                : permission
                  ? 'permission'
                  : waiting || timeout
                    ? 'waiting'
                    : 'error',
          waitingForExit: code !== 0 && waiting,
          needsCacheGrant: cachePermission,
          initialized: code === 0 || !!this.lib.data.connectors.wechat.initialized,
          lastScan: Date.now(),
          message:
            code === 0
              ? `本次新增 ${r.added} 个 · 忽略重复 ${r.duplicates} 个${failed ? ' · 下载失败 ' + failed + ' 个' : ''}`
              : permission
                ? cachePermission
                  ? '表情原件已保留。请点「授权助手缓存」，允许访问助手缓存目录后继续同步。'
                  : '微信助手读取被 macOS 拒绝。请点「授权目录」选择微信数据目录后重试。'
                : waiting
                  ? '等待退出正在运行的微信；退出后会自动继续，并打开微信副本。'
                  : timeout
                    ? '等待登录超时，请重试并在微信副本中登录、打开表情面板。'
                    : `读取未完成，已导入 ${r.added} 个。${error ? '助手未能启动。' : '请确认网络及微信登录状态后重试。'}`,
        });
      } finally {
        this.busy.delete('wechat');
        this.wechatChild = null;
        await this.persist();
      }
    };
    child.once('error', (e) => finish(1, e));
    child.once('close', (code) => finish(code));
  }
  async tick() {
    if (this.lib.data.connectors.qq?.enabled) await this.qq();
    const w = this.lib.data.connectors.wechat;
    if (
      w?.enabled &&
      (w.waitingForExit || (w.initialized && Date.now() - (w.lastScan || 0) > 300000))
    )
      await this.wechat(w.account);
  }
  async disable(id) {
    if (this.busy.has(id)) throw Error('正在同步，请等待当前任务完成后停用。');
    this.status(id, { enabled: false, status: 'disabled', message: '自动读取已停用' });
    await this.persist();
  }
}
function collectedStickers(data) {
  if (data.status_code !== 0 || !data.custom_sticker_page_list)
    throw Error('未收到收藏列表，可能需要重新登录。');
  const page = data.custom_sticker_page_list;
  const out = [];
  for (const r of page.resources || [])
    for (const s of r.stickers || []) {
      const animate = s.animate_url?.url_list || [];
      const isAnimated = !!s.animate_url;
      const urls = isAnimated ? animate : s.static_url?.url_list || [];
      if (urls.length)
        out.push({
          id: String(s.id_str || s.id || ''),
          animated: isAnimated,
          url: urls.find((u) => u.toLowerCase().includes('origin')) || urls[0],
        });
    }
  return { items: out, hasMore: !!page.has_more, cursor: page.next_cursor };
}
function allowedCDN(raw) {
  try {
    const u = new URL(raw);
    return (
      u.protocol === 'https:' &&
      !u.username &&
      !u.password &&
      (!u.port || u.port === '443') &&
      [
        'douyinpic.com',
        'byteimg.com',
        'pstatp.com',
        'douyincdn.com',
        'ibytedtos.com',
        'bytecdn.cn',
        'byteimg.cn',
      ].some((d) => u.hostname === d || u.hostname.endsWith('.' + d))
    );
  } catch {
    return false;
  }
}
async function downloadSticker(url, dest, animated) {
  for (let hop = 0; hop < 5; hop++) {
    if (!allowedCDN(url)) throw Error('表情地址不是已支持的抖音图片域名');
    const r = await fetch(url, {
      redirect: 'manual',
      signal: AbortSignal.timeout(30000),
      headers: { Referer: 'https://www.douyin.com/' },
    });
    if (r.status >= 300 && r.status < 400) {
      url = new URL(r.headers.get('location'), url).href;
      continue;
    }
    if (!r.ok) throw Error('图片下载失败 ' + r.status);
    const chunks = [];
    let bytes = 0;
    for await (const chunk of r.body) {
      bytes += chunk.length;
      if (bytes > 100 * 1024 * 1024) throw Error('图片超过 100MB');
      chunks.push(chunk);
    }
    const b = Buffer.concat(chunks),
      type = identify(b);
    if (!type) throw Error('收到的不是受支持图片');
    if (animated && !type.animated) throw Error('动态表情未取得动画原件，已跳过静态版本');
    await fs.writeFile(dest, b);
    return;
  }
  throw Error('图片跳转次数过多');
}
module.exports = {
  Connectors,
  discoverQQ,
  wechatAccounts,
  collectedStickers,
  allowedCDN,
  downloadSticker,
};
