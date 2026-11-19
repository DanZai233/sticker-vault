const fs = require('node:fs/promises');
const path = require('node:path');
const { environmentPaths } = require('./wechat-paths.cjs');
async function directory(p) {
  try {
    return (await fs.stat(p)).isDirectory();
  } catch (e) {
    if (['ENOENT', 'ENOTDIR'].includes(e.code)) return false;
    throw e;
  }
}
async function discoverQQPaths(options = {}) {
  const p = environmentPaths(options);
  let bases = options.override
    ? [options.override]
    : p.platform === 'darwin'
      ? [path.join(p.home, 'Library/Containers/com.tencent.qq/Data/Library/Application Support/QQ')]
      : p.platform === 'win32'
        ? [
            path.join(p.documents, 'Tencent Files'),
            path.join(p.home, 'Documents/Tencent Files'),
            path.join(p.documents, 'QQ Files'),
            path.join(p.appData, 'Tencent/QQ'),
            path.join(p.appData, 'QQ'),
            path.join(p.localAppData, 'Tencent/QQ'),
          ]
        : [path.join(p.home, '.config/QQ')];
  if (p.platform === 'win32' && !options.override) {
    const config = path.join(p.appData, 'Tencent/QQ/Misc/UserDataInfo.ini');
    try {
      const st = await fs.stat(config);
      if (st.size <= 16384) {
        const b = await fs.readFile(config);
        const text = (
          (b[1] === 0 && b[3] === 0) || (b[0] === 255 && b[1] === 254)
            ? b.toString('utf16le')
            : b.toString('utf8')
        ).replace(/^\uFEFF/, '');
        const match = text.match(/^UserData(?:Save)?Path\s*=\s*(.+)$/im);
        const custom = match?.[1].trim().replace(/^["']|["']$/g, '');
        if (custom && path.isAbsolute(custom) && !custom.startsWith('\\\\')) bases.unshift(custom);
      }
    } catch (e) {
      if (!['ENOENT', 'ENOTDIR', 'EPERM', 'EACCES'].includes(e.code)) throw e;
    }
  }
  const found = new Set(),
    seen = new Set();
  let denied;
  async function inspect(root, depth = 0) {
    if (depth > 3 || seen.has(root)) return;
    seen.add(root);
    try {
      if (
        path.basename(root) === 'Ori' &&
        path.basename(path.dirname(root)) === 'personal_emoji' &&
        (await directory(root))
      ) {
        found.add(root);
        return;
      }
      // Each accepted source is an original store; never fall back to Thumb, received pictures, or bundled resources.
      const layouts = [
        'personal_emoji/Ori',
        'Emoji/personal_emoji/Ori',
        'nt_data/Emoji/personal_emoji/Ori',
        'nt_qq/nt_data/Emoji/personal_emoji/Ori',
      ];
      if (path.basename(root) === 'personal_emoji') layouts.unshift('Ori');
      for (const rel of layouts) {
        const candidate = path.join(root, rel);
        if (await directory(candidate)) found.add(candidate);
      }
      let entries;
      try {
        entries = await fs.readdir(root, { withFileTypes: true });
      } catch (e) {
        if (['ENOENT', 'ENOTDIR'].includes(e.code)) return;
        throw e;
      }
      for (const entry of entries) {
        if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
        const name = entry.name;
        if (
          /^(?:nt_qq(?:_|$)|\d+$)/.test(name) ||
          ['QQ', 'QQ Files', 'Tencent Files', 'nt_data', 'Emoji', 'personal_emoji'].includes(name)
        )
          await inspect(path.join(root, name), depth + 1);
      }
    } catch (e) {
      if (['EPERM', 'EACCES'].includes(e.code)) {
        denied = e;
        return;
      }
      throw e;
    }
  }
  for (const root of [...new Set(bases)]) await inspect(root);
  if (!found.size && denied) throw denied;
  return [...found];
}
module.exports = { discoverQQPaths };
