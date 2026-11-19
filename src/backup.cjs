const fs = require('node:fs/promises');
const fss = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { pipeline } = require('node:stream/promises');
const { Transform } = require('node:stream');
const yauzl = require('yauzl');
const yazl = require('yazl');
const { identify } = require('./library.cjs');
const { restoreOcr } = require('./ocr.cjs');
const MAX_FILE = 100 * 1024 * 1024,
  MAX_META = 64 * 1024 * 1024;
const MAX_TOTAL = 20 * 1024 * 1024 * 1024,
  MAX_ITEMS = 100000;
const hashPattern = /^[a-f0-9]{64}$/;
const text = (s, n = 200) => (typeof s === 'string' ? s.slice(0, n) : '');
const time = (n) => (Number.isSafeInteger(n) && n >= 0 ? Math.min(n, Date.now() + 86400000) : 0);
const tags = (value) =>
  [
    ...new Set(
      (Array.isArray(value) ? value : [])
        .filter((s) => typeof s === 'string')
        .map((s) => s.slice(0, 40)),
    ),
  ].slice(0, 100);
function cleanRecord(value) {
  if (!value || !['done', 'error', 'interrupted', 'processing'].includes(value.status))
    throw Error('OCR 记录格式无效');
  return {
    status: value.status === 'processing' ? 'interrupted' : value.status,
    text: text(value.text, 4000),
    tags: tags(value.tags),
    startedAt: time(value.startedAt),
    finishedAt: time(value.finishedAt),
    error: text(value.error, 300),
    confidence: Number.isFinite(value.confidence)
      ? Math.max(0, Math.min(100, value.confidence))
      : null,
  };
}
function cleanItem(i) {
  if (
    !i ||
    !hashPattern.test(i.id) ||
    !/^(gif|png|jpg|webp)$/.test(i.ext) ||
    i.file !== i.id + '.' + i.ext ||
    !Number.isSafeInteger(i.size) ||
    i.size < 1 ||
    i.size > MAX_FILE
  )
    throw Error('备份中的图片信息无效');
  return {
    id: i.id,
    file: i.file,
    ext: i.ext,
    size: i.size,
    animated: !!i.animated,
    name: text(i.name) || '未命名表情',
    source: text(i.source) || '本地导入',
    tags: tags(i.tags),
    favorite: !!i.favorite,
    createdAt: time(i.createdAt),
    lastUsedAt: time(i.lastUsedAt),
    useCount: Math.min(1e9, Math.max(0, Math.floor(Number(i.useCount) || 0))),
    moveOrderAt: time(i.moveOrderAt),
    fieldUpdatedAt: Object.fromEntries(
      ['name', 'tags', 'favorite'].map((key) => [key, time(i.fieldUpdatedAt?.[key])]),
    ),
  };
}
function validateManifest(raw) {
  if (
    !raw ||
    raw.format !== 'stickervault-backup' ||
    raw.version !== 1 ||
    !Array.isArray(raw.items) ||
    raw.items.length > MAX_ITEMS
  )
    throw Error('不是支持的表情仓备份（格式版本 1）');
  const items = raw.items.map(cleanItem),
    ids = new Set(items.map((i) => i.id));
  if (ids.size !== items.length || items.reduce((n, i) => n + i.size, 0) > MAX_TOTAL)
    throw Error('备份重复或超过容量限制');
  const entries = Object.entries(raw.ocrRecords || {});
  if (entries.length > MAX_ITEMS * 2) throw Error('OCR 记录过多');
  const ocrRecords = {};
  for (const [id, record] of entries) {
    if (!hashPattern.test(id)) throw Error('OCR 图片标识无效');
    ocrRecords[id] = cleanRecord(record);
  }
  const config = raw.config || {};
  return {
    format: raw.format,
    version: 1,
    exportedAt: time(raw.exportedAt),
    items,
    ocrRecords,
    config: {
      ocrEnabled: typeof config.ocrEnabled === 'boolean' ? config.ocrEnabled : true,
      ocrUpdatedAt: time(config.ocrUpdatedAt),
      startupRequested: !!config.startupRequested,
      folders: (Array.isArray(config.folders) ? config.folders : [])
        .slice(0, 1000)
        .map((f) => ({ path: text(f.path, 2048), source: text(f.source) })),
      connections: (Array.isArray(config.connections) ? config.connections : [])
        .slice(0, 10)
        .filter((c) => ['qq', 'wechat', 'douyin'].includes(c.provider))
        .map((c) => ({ provider: c.provider, enabled: !!c.enabled, base: text(c.base, 2048) })),
      webdav: config.webdav
        ? { url: text(config.webdav.url, 2048), username: text(config.webdav.username, 300) }
        : null,
    },
  };
}
function snapshotManifest(lib, config = {}) {
  const data = lib.data;
  return validateManifest({
    format: 'stickervault-backup',
    version: 1,
    exportedAt: Date.now(),
    items: data.items,
    ocrRecords: data.ocrRecords || {},
    config: {
      ocrEnabled: data.settings?.ocrEnabled !== false,
      ocrUpdatedAt: data.settingsUpdatedAt?.ocrEnabled || 0,
      folders: [...(data.folders || []), ...(data.migrationHints?.folders || [])],
      connections: [
        ...Object.entries(data.connectors || {}).map(([provider, c]) => ({
          provider,
          enabled: c.enabled,
          base: c.base,
        })),
        ...(data.migrationHints?.connections || []),
      ],
      ...config,
      startupRequested: !!config.startupRequested || !!data.migrationHints?.startupRequested,
      webdav: config.webdav || data.migrationHints?.webdav || null,
    },
  });
}
function mergeItem(a, b) {
  const result = { ...a, fieldUpdatedAt: {} };
  for (const key of ['name', 'tags', 'favorite']) {
    const at = a.fieldUpdatedAt?.[key] || 0,
      bt = b.fieldUpdatedAt?.[key] || 0;
    if (at || bt)
      result[key] =
        bt > at || (bt === at && JSON.stringify(b[key]) > JSON.stringify(a[key])) ? b[key] : a[key];
    else if (key === 'tags') result.tags = [...new Set([...a.tags, ...b.tags])].sort();
    else if (key === 'favorite') result.favorite = a.favorite || b.favorite;
    else result.name = [a.name, b.name].filter(Boolean).sort()[0] || '未命名表情';
    result.fieldUpdatedAt[key] = Math.max(at, bt);
  }
  for (const key of ['lastUsedAt', 'useCount', 'moveOrderAt'])
    result[key] = Math.max(a[key] || 0, b[key] || 0);
  result.createdAt = Math.min(a.createdAt || b.createdAt, b.createdAt || a.createdAt);
  return result;
}
function mergeRecord(a, b) {
  if (!a) return b;
  if (!b) return a;
  const rank = (r) => (r.status === 'done' ? 2 : r.status === 'processing' ? 0 : 1);
  return rank(a) !== rank(b)
    ? rank(a) > rank(b)
      ? a
      : b
    : (a.finishedAt || 0) !== (b.finishedAt || 0)
      ? (a.finishedAt || 0) > (b.finishedAt || 0)
        ? a
        : b
      : JSON.stringify(a) > JSON.stringify(b)
        ? a
        : b;
}
async function exportBackup(lib, file, { config = {}, progress = () => {}, signal } = {}) {
  return lib.run(async () => {
    const manifest = snapshotManifest(lib, config),
      zip = new yazl.ZipFile(),
      temporary = file + '.' + crypto.randomUUID() + '.tmp';
    let total = 0;
    try {
      // Validate before writing so a missing/corrupt original never looks like a valid backup.
      for (const item of manifest.items) {
        signal?.throwIfAborted();
        const bytes = await fs.readFile(path.join(lib.root, 'originals', item.file));
        if (
          bytes.length !== item.size ||
          crypto.createHash('sha256').update(bytes).digest('hex') !== item.id
        )
          throw Error('原件缺失或校验失败，备份未完成：' + item.name);
        progress({ phase: 'exporting', done: ++total, total: manifest.items.length });
      }
      zip.addBuffer(Buffer.from(JSON.stringify(manifest)), 'manifest.json');
      for (const item of manifest.items)
        zip.addFile(path.join(lib.root, 'originals', item.file), 'originals/' + item.file, {
          compress: false,
        });
      const writing = pipeline(
        zip.outputStream,
        fss.createWriteStream(temporary, { flags: 'wx', mode: 0o600 }),
        { signal },
      );
      zip.on('error', (error) => zip.outputStream.destroy(error));
      zip.end();
      await writing;
      await fs.rename(temporary, file);
      return { count: manifest.items.length, bytes: (await fs.stat(file)).size };
    } catch (error) {
      zip.outputStream.destroy();
      await fs.unlink(temporary).catch(() => {});
      throw error;
    }
  });
}
async function stageBackup(file, { progress = () => {}, signal } = {}) {
  const directory = await fs.mkdtemp(path.join(require('node:os').tmpdir(), 'sticker-backup-'));
  let zip;
  try {
    zip = await new Promise((resolve, reject) =>
      yauzl.open(
        file,
        { lazyEntries: true, autoClose: false, validateEntrySizes: true },
        (error, value) => (error ? reject(error) : resolve(value)),
      ),
    );
    let total = 0,
      manifestBytes;
    const disk = await fs.statfs(directory),
      available = Math.max(0, Number(disk.bavail) * Number(disk.bsize) - 256 * 1024 * 1024);
    const names = new Set();
    await new Promise((resolve, reject) => {
      zip.on('error', reject);
      zip.on('end', resolve);
      zip.on('entry', (entry) => {
        (async () => {
          signal?.throwIfAborted();
          const name = entry.fileName;
          if (
            names.has(name) ||
            (name !== 'manifest.json' &&
              !/^originals\/[a-f0-9]{64}\.(gif|png|jpg|webp)$/.test(name)) ||
            ((entry.externalFileAttributes >>> 16) & 0o170000) === 0o120000 ||
            entry.isEncrypted()
          )
            throw Error('备份包含重复、加密或不安全的文件路径');
          names.add(name);
          if (
            names.size > MAX_ITEMS + 1 ||
            entry.uncompressedSize > (name === 'manifest.json' ? MAX_META : MAX_FILE) ||
            (total += entry.uncompressedSize) > Math.min(MAX_TOTAL + MAX_META, available)
          )
            throw Error('备份超过容量限制');
          const stream = await new Promise((ok, no) =>
            zip.openReadStream(entry, (error, value) => (error ? no(error) : ok(value))),
          );
          let size = 0;
          const chunks = [];
          const limit = new Transform({
            transform(chunk, encoding, callback) {
              size += chunk.length;
              if (size > entry.uncompressedSize) callback(Error('备份解压大小不匹配'));
              else callback(null, chunk);
            },
          });
          if (name === 'manifest.json') {
            limit.on('data', (chunk) => chunks.push(chunk));
            await pipeline(stream, limit, { signal });
            manifestBytes = Buffer.concat(chunks);
          } else
            await pipeline(
              stream,
              limit,
              fss.createWriteStream(path.join(directory, path.basename(name)), {
                flags: 'wx',
                mode: 0o600,
              }),
              { signal },
            );
          progress({ phase: 'validating', done: names.size, total: zip.entryCount });
          zip.readEntry();
        })().catch(reject);
      });
      zip.readEntry();
    });
    if (!manifestBytes) throw Error('备份缺少清单');
    const manifest = validateManifest(JSON.parse(manifestBytes.toString('utf8')));
    if (names.size !== manifest.items.length + 1) throw Error('备份清单与文件数量不一致');
    for (const item of manifest.items) {
      if (!names.has('originals/' + item.file)) throw Error('备份缺少图片原件');
      const bytes = await fs.readFile(path.join(directory, item.file)),
        type = identify(bytes);
      if (
        bytes.length !== item.size ||
        crypto.createHash('sha256').update(bytes).digest('hex') !== item.id ||
        !type ||
        type.ext !== item.ext ||
        type.animated !== item.animated
      )
        throw Error('备份图片校验失败');
    }
    return {
      manifest,
      directory,
      cleanup: () => fs.rm(directory, { recursive: true, force: true }),
    };
  } catch (error) {
    await fs.rm(directory, { recursive: true, force: true });
    throw Error('无法读取备份：' + error.message);
  } finally {
    zip?.close();
  }
}
async function mergeStaged(lib, staged, { restoreSettings = true } = {}) {
  return lib.run(async () => {
    const incoming = staged.manifest,
      previous = structuredClone(lib.data),
      next = structuredClone(lib.data),
      byId = new Map(next.items.map((i) => [i.id, i]));
    let added = 0,
      merged = 0;
    for (const incomingItem of incoming.items) {
      const old = byId.get(incomingItem.id);
      const item = old ? mergeItem(cleanItem(old), incomingItem) : structuredClone(incomingItem);
      byId.set(item.id, item);
      old ? merged++ : added++;
    }
    next.ocrRecords ??= {};
    for (const [id, record] of Object.entries(incoming.ocrRecords))
      next.ocrRecords[id] = mergeRecord(next.ocrRecords[id], record);
    next.items = [...byId.values()].map((item) =>
      restoreOcr(item, next.ocrRecords[item.id], { mergeTags: false }),
    );
    next.items.sort(
      (a, b) =>
        Math.max(b.moveOrderAt || 0, b.createdAt) - Math.max(a.moveOrderAt || 0, a.createdAt),
    );
    if (restoreSettings) {
      const at = next.settingsUpdatedAt?.ocrEnabled || 0,
        bt = incoming.config.ocrUpdatedAt;
      if (bt > at || (!previous.items.length && !at)) {
        next.settings = { ...next.settings, ocrEnabled: incoming.config.ocrEnabled };
        next.settingsUpdatedAt = { ...next.settingsUpdatedAt, ocrEnabled: bt };
      }
    }
    next.migrationHints ??= { folders: [], connections: [] };
    for (const key of ['folders', 'connections']) {
      const values = [...(next.migrationHints[key] || []), ...incoming.config[key]];
      next.migrationHints[key] = [
        ...new Map(values.map((value) => [JSON.stringify(value), value])).values(),
      ].slice(0, 1000);
    }
    next.migrationHints.startupRequested ||= incoming.config.startupRequested;
    if (incoming.config.webdav) next.migrationHints.webdav = incoming.config.webdav;
    const recovery = path.join(lib.root, 'recovery');
    await fs.mkdir(recovery, { recursive: true });
    const recoveryFile = path.join(
      recovery,
      'before-merge-' + Date.now() + '-' + crypto.randomUUID() + '.json',
    );
    await fs.writeFile(recoveryFile, JSON.stringify(previous), { mode: 0o600, flag: 'wx' });
    // No deletions: verified originals are only added/repaired; existing metadata is committed last.
    for (const item of incoming.items) {
      const destination = path.join(lib.root, 'originals', item.file);
      let valid = false;
      try {
        const bytes = await fs.readFile(destination);
        valid = crypto.createHash('sha256').update(bytes).digest('hex') === item.id;
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      if (!valid) {
        const temp = destination + '.' + crypto.randomUUID() + '.tmp';
        try {
          await fs.copyFile(path.join(staged.directory, item.file), temp);
          await fs.rename(temp, destination);
        } finally {
          await fs.unlink(temp).catch(() => {});
        }
      }
    }
    lib.data = next;
    try {
      await lib.save();
    } catch (error) {
      lib.data = previous;
      throw error;
    }
    return {
      added,
      merged,
      total: next.items.length,
      recoveryFile,
      hints:
        incoming.config.folders.length +
        incoming.config.connections.filter((c) => c.enabled).length,
    };
  });
}
module.exports = {
  exportBackup,
  stageBackup,
  mergeStaged,
  validateManifest,
  snapshotManifest,
  mergeItem,
  MAX_TOTAL,
};
