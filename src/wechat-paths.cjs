const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');

function environmentPaths(options = {}) {
  const home = options.home || os.homedir();
  const platform = options.platform || process.platform;
  const useEnvironment = home === os.homedir();
  return {
    home,
    platform,
    documents: options.documents || path.join(home, 'Documents'),
    appData:
      options.appData ||
      (platform === 'win32'
        ? (useEnvironment && process.env.APPDATA) || path.join(home, 'AppData/Roaming')
        : ''),
    localAppData:
      options.localAppData ||
      (platform === 'win32'
        ? (useEnvironment && process.env.LOCALAPPDATA) || path.join(home, 'AppData/Local')
        : ''),
    oneDrive:
      options.oneDrive ||
      (platform === 'win32'
        ? (useEnvironment && process.env.OneDrive) || path.join(home, 'OneDrive')
        : ''),
  };
}
function wechatCacheDirectory(options = {}) {
  const p = environmentPaths(options);
  return p.platform === 'win32'
    ? path.join(p.localAppData, 'wxemoticon')
    : path.join(
        p.home,
        'Library/Containers/com.tencent.xinWeChat/Data/Documents/export-wechat-emoji',
      );
}
function helperName(platform = process.platform) {
  return platform === 'win32' ? 'wxemoticon.exe' : 'wxemoticon';
}
async function exists(p) {
  try {
    return (await fs.stat(p)).isDirectory();
  } catch (e) {
    if (e.code === 'ENOENT' || e.code === 'ENOTDIR') return false;
    throw e;
  }
}
async function children(p) {
  try {
    return (await fs.readdir(p, { withFileTypes: true }))
      .filter((e) => e.isDirectory() && !e.isSymbolicLink() && !e.name.startsWith('.'))
      .map((e) => path.join(p, e.name));
  } catch (e) {
    if (e.code === 'ENOENT' || e.code === 'ENOTDIR') return [];
    throw e;
  }
}
async function hasDatabase(p) {
  try {
    return (await fs.stat(path.join(p, 'db_storage/emoticon/emoticon.db'))).isFile();
  } catch (e) {
    if (e.code === 'ENOENT' || e.code === 'ENOTDIR') return false;
    throw e;
  }
}
async function discoverWechat(options = {}) {
  const p = environmentPaths(options);
  let bases = options.override
    ? [options.override]
    : p.platform === 'darwin'
      ? [path.join(p.home, 'Library/Containers/com.tencent.xinWeChat/Data/Documents/xwechat_files')]
      : p.platform === 'win32'
        ? [
            path.join(p.home, 'xwechat_files'),
            path.join(p.documents, 'xwechat_files'),
            path.join(p.home, 'Documents/xwechat_files'),
            path.join(p.oneDrive, 'Documents/xwechat_files'),
          ]
        : [path.join(p.home, 'Documents/xwechat_files'), path.join(p.home, '文档/xwechat_files')];
  // Windows stores a user-selected data parent in this small configuration file.
  // Do not scan drives, chats, or arbitrary profile directories.
  if (p.platform === 'win32' && !options.override) {
    for (const product of ['WeChat', 'Weixin', 'xwechat']) {
      const config = path.join(p.appData, 'Tencent', product, 'All Users/config/3ebffe94.ini');
      try {
        const st = await fs.stat(config);
        if (st.size > 16384) continue;
        const b = await fs.readFile(config);
        const text = (
          (b[0] === 255 && b[1] === 254) || (b[1] === 0 && b[3] === 0)
            ? b.toString('utf16le')
            : b.toString('utf8')
        )
          .replace(/^\uFEFF/, '')
          .replace(/\0/g, '');
        const candidate = text
          .split(/[\r\n]/)
          .map((s) => s.trim().replace(/^["']|["']$/g, ''))
          .find((s) => path.isAbsolute(s) && !s.startsWith('\\\\'));
        if (candidate) bases.unshift(candidate, path.join(candidate, 'xwechat_files'));
      } catch (e) {
        if (!['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM'].includes(e.code)) throw e;
      }
    }
  }
  const examined = [],
    accounts = [],
    legacyRoots = [];
  let denied;
  async function inspect(root, depth = 0) {
    if (depth > 2) return;
    if (examined.includes(root)) return;
    examined.push(root);
    try {
      // Accept xwechat_files, an account folder, or a chosen data parent.
      const normalized = path.basename(root) === 'db_storage' ? path.dirname(root) : root;
      if (await hasDatabase(normalized)) {
        const db = path.join(normalized, 'db_storage/emoticon/emoticon.db');
        accounts.push({
          id: path.basename(normalized),
          root: path.dirname(normalized),
          modified: (await fs.stat(db)).mtimeMs,
        });
        return;
      }
      for (const child of await children(root)) {
        if (await hasDatabase(child))
          accounts.push({
            id: path.basename(child),
            root,
            modified: (await fs.stat(path.join(child, 'db_storage/emoticon/emoticon.db'))).mtimeMs,
          });
        else if (
          (await exists(path.join(child, 'Msg'))) ||
          (await exists(path.join(child, 'CustomEmotions')))
        )
          legacyRoots.push(root);
      }
      const nested = path.join(root, 'xwechat_files');
      if (await exists(nested)) await inspect(nested, depth + 1);
    } catch (e) {
      if (['EACCES', 'EPERM'].includes(e.code)) {
        denied = e;
        return;
      }
      throw e;
    }
  }
  for (const base of [...new Set(bases)]) await inspect(base);
  if (!accounts.length && denied) throw denied;
  const unique = new Map();
  for (const a of accounts)
    if (!unique.has(a.id) || unique.get(a.id).modified < a.modified) unique.set(a.id, a);
  return {
    accounts: [...unique.values()].sort((a, b) => a.id.localeCompare(b.id)),
    examined,
    legacy: legacyRoots.length > 0,
  };
}
async function connectorDefaultDirectory(id, options = {}) {
  const p = environmentPaths(options);
  if (id === 'wechat') {
    const result = await discoverWechat(options).catch(() => ({ accounts: [] }));
    if (result.accounts.length) return result.accounts[0].root;
    const candidates =
      p.platform === 'darwin'
        ? [
            path.join(
              p.home,
              'Library/Containers/com.tencent.xinWeChat/Data/Documents/xwechat_files',
            ),
          ]
        : [
            path.join(p.home, 'xwechat_files'),
            path.join(p.documents, 'xwechat_files'),
            p.documents,
            p.home,
          ];
    for (const c of candidates) if (await exists(c).catch(() => false)) return c;
    return p.home;
  }
  const candidates =
    p.platform === 'darwin'
      ? [path.join(p.home, 'Library/Containers/com.tencent.qq/Data/Library/Application Support/QQ')]
      : p.platform === 'win32'
        ? [path.join(p.documents, 'Tencent Files'), path.join(p.appData, 'Tencent/QQ'), p.documents]
        : [path.join(p.home, '.config/QQ'), p.home];
  for (const c of candidates) if (await exists(c).catch(() => false)) return c;
  return p.home;
}
module.exports = {
  environmentPaths,
  wechatCacheDirectory,
  helperName,
  discoverWechat,
  connectorDefaultDirectory,
};
