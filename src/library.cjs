const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { ImportReport, reasonFor } = require('./import-diagnostics.cjs');
function identify(b) {
  if (
    b
      .subarray(0, 6)
      .toString()
      .match(/^GIF8[79]a$/)
  )
    return { ext: 'gif', animated: gifFrames(b) > 1 };
  if (b.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))
    return { ext: 'png', animated: b.includes(Buffer.from('acTL')) };
  if (b[0] === 255 && b[1] === 216 && b[2] === 255) return { ext: 'jpg', animated: false };
  if (b.subarray(0, 4).toString() === 'RIFF' && b.subarray(8, 12).toString() === 'WEBP')
    return { ext: 'webp', animated: b.includes(Buffer.from('ANIM')) };
  return null;
}
function gifFrames(b) {
  if (b.length < 13) return 0;
  let p = 13 + (b[10] & 128 ? 3 * 2 ** ((b[10] & 7) + 1) : 0),
    frames = 0;
  const skip = () => {
    while (p < b.length) {
      const n = b[p++];
      if (!n) break;
      p += n;
    }
  };
  while (p < b.length) {
    const tag = b[p++];
    if (tag === 0x3b) break;
    if (tag === 0x21) {
      p++;
      skip();
    } else if (tag === 0x2c) {
      if (p + 9 > b.length) break;
      const packed = b[p + 8];
      p += 9;
      if (packed & 128) p += 3 * 2 ** ((packed & 7) + 1);
      p++;
      skip();
      frames++;
    } else break;
  }
  return frames;
}
class Library {
  constructor(root) {
    this.root = root;
    this.data = { items: [], folders: [] };
    this.queue = Promise.resolve();
  }
  async init() {
    await fs.mkdir(path.join(this.root, 'originals'), { recursive: true });
    try {
      this.data = JSON.parse(await fs.readFile(path.join(this.root, 'library.json'), 'utf8'));
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
    }
    this.data.trash ??= [];
    this.data.importReports ??= [];
    return this;
  }
  async save() {
    const p = path.join(this.root, 'library.json');
    await fs.writeFile(p + '.tmp', JSON.stringify(this.data, null, 2));
    await fs.rename(p + '.tmp', p);
  }
  run(fn) {
    const next = this.queue.then(fn);
    this.queue = next.catch(() => {});
    return next;
  }
  async collect(paths, { onIssue } = {}) {
    const out = [],
      visited = new Set();
    const issue = (file, code, error) => {
      if (onIssue) onIssue(file, code, error);
      else if (error) throw error;
    };
    const walk = async (file, depth) => {
      if (depth > 12) {
        issue(file, 'depth');
        return;
      }
      try {
        const stat = await fs.lstat(file);
        if (stat.isSymbolicLink()) {
          issue(file, 'symlink');
          return;
        }
        if (stat.isDirectory()) {
          const real = await fs.realpath(file);
          if (visited.has(real)) return;
          visited.add(real);
          for (const name of await fs.readdir(file)) {
            const child = path.join(file, name);
            if (name.startsWith('.')) {
              issue(child, 'hidden');
              continue;
            }
            await walk(child, depth + 1);
          }
        } else if (stat.isFile()) {
          if (!stat.size) issue(file, 'empty');
          else if (stat.size > 100 * 1024 * 1024) issue(file, 'too_large');
          else out.push(file);
        }
      } catch (error) {
        issue(file, reasonFor(error), error);
      }
    };
    for (const file of paths) await walk(file, 0);
    return out;
  }
  import(paths, source = '本地导入', { restoreTrash = true, automatic = false } = {}) {
    return this.run(async () => {
      const report = new ImportReport(source),
        errors = [],
        known = new Set(this.data.items.map((item) => item.id)),
        trashed = new Map((this.data.trash || []).map((item) => [item.id, item]));
      const files = await this.collect(paths, {
        onIssue: (file, code, error) => {
          report.add(file, error ? 'failed' : 'skipped', code, error);
          if (error && errors.length < 500) errors.push(path.basename(file) + ': ' + error.message);
        },
      });
      for (const filePath of files) {
        try {
          const bytes = await fs.readFile(filePath),
            type = identify(bytes);
          if (bytes.length > 100 * 1024 * 1024) {
            report.add(filePath, 'skipped', 'too_large');
            continue;
          }
          if (!type) {
            report.add(filePath, 'skipped', 'unsupported');
            continue;
          }
          const id = crypto.createHash('sha256').update(bytes).digest('hex');
          if (known.has(id)) {
            report.add(filePath, 'duplicate', 'duplicate');
            continue;
          }
          const old = trashed.get(id);
          if (old && !restoreTrash) {
            report.add(filePath, 'skipped', 'in_trash');
            continue;
          }
          const file = id + '.' + type.ext;
          await fs.writeFile(path.join(this.root, 'originals', file), bytes);
          const imported = old
            ? { ...old }
            : {
                id,
                file,
                name: path.parse(filePath).name,
                ...type,
                size: bytes.length,
                source,
                tags: [],
                favorite: false,
                createdAt: Date.now(),
              };
          delete imported.deletedAt;
          delete imported.deleteBatch;
          require('./ocr.cjs').restoreOcr(imported, this.data.ocrRecords?.[id], {
            mergeTags: !old,
          });
          this.data.items.unshift(imported);
          known.add(id);
          if (old) {
            this.data.trash = this.data.trash.filter((item) => item.id !== id);
            trashed.delete(id);
            report.add(filePath, 'restored', 'restored');
          } else report.add(filePath, 'added', 'added');
        } catch (error) {
          report.add(filePath, 'failed', reasonFor(error), error);
          if (errors.length < 500) errors.push(path.basename(filePath) + ': ' + error.message);
        }
      }
      let reportId, diagnosticWarning;
      try {
        reportId = await report.persist(this, { automatic });
      } catch {
        diagnosticWarning = '导入诊断暂未保存，请检查可用磁盘空间。';
      }
      await this.save();
      return {
        added: report.counts.added,
        restored: report.counts.restored,
        duplicates: report.counts.duplicate,
        skipped: report.counts.skipped,
        actionableSkipped: report.actionableSkipped,
        failed: report.counts.failed,
        errors,
        reportId,
        diagnosticWarning,
      };
    });
  }
  update(id, patch) {
    return this.run(async () => {
      const item = this.data.items.find((i) => i.id === id);
      if (!item) throw Error('表情不存在');
      for (const key of ['name', 'tags', 'favorite', 'lastUsedAt', 'useCount'])
        if (key in patch) {
          item[key] = patch[key];
          if (['name', 'tags', 'favorite'].includes(key)) {
            item.fieldUpdatedAt ??= {};
            item.fieldUpdatedAt[key] = Date.now();
          }
        }
      await this.save();
    });
  }
  moveToFront(id) {
    return this.run(async () => {
      const index = this.data.items.findIndex((item) => item.id === id);
      if (index < 0) throw Error('表情不存在');
      const latestOrder = this.data.items.reduce(
        (latest, item) =>
          Math.max(latest, item.moveOrderAt || 0, item.createdAt || 0, item.lastUsedAt || 0),
        0,
      );
      const [item] = this.data.items.splice(index, 1);
      // Repeating the action moves forward again; there is no pinned flag to toggle.
      item.moveOrderAt = Math.max(Date.now(), latestOrder + 1);
      this.data.items.unshift(item);
      await this.save();
    });
  }
  remove(ids) {
    return this.run(async () => {
      const previous = this.data,
        deletedAt = Date.now(),
        batchId = crypto.randomUUID(),
        wanted = new Set(ids);
      const removed = previous.items.filter((item) => wanted.has(item.id));
      this.data = {
        ...previous,
        items: previous.items.filter((item) => !wanted.has(item.id)),
        trash: [
          ...(previous.trash || []),
          ...removed.map((item) => ({ ...item, deletedAt, deleteBatch: batchId })),
        ],
      };
      try {
        await this.save();
      } catch (error) {
        this.data = previous;
        throw error;
      }
      return { batchId, ids: removed.map((item) => item.id), count: removed.length };
    });
  }
  restore(ids) {
    return this.run(async () => {
      const wanted = new Set(ids),
        previous = this.data,
        active = new Set(previous.items.map((item) => item.id)),
        restored = [],
        failed = [];
      for (const old of previous.trash || []) {
        if (!wanted.has(old.id)) continue;
        try {
          const file = this.originalPath(old);
          await fs.access(file);
          if (!active.has(old.id)) {
            const item = { ...old };
            delete item.deletedAt;
            delete item.deleteBatch;
            require('./ocr.cjs').restoreOcr(item, previous.ocrRecords?.[item.id], {
              mergeTags: false,
            });
            restored.push(item);
            active.add(item.id);
          }
        } catch (error) {
          failed.push({ id: old.id, name: old.name, error: error.message });
        }
      }
      const failures = new Set(failed.map((item) => item.id));
      this.data = {
        ...previous,
        items: [...restored, ...previous.items],
        trash: (previous.trash || []).filter(
          (item) => !wanted.has(item.id) || failures.has(item.id),
        ),
      };
      try {
        await this.save();
      } catch (error) {
        this.data = previous;
        throw error;
      }
      return { restored: restored.length, failed };
    });
  }
  originalPath(item) {
    if (
      !/^[a-f0-9]{64}\.(gif|png|jpg|webp)$/.test(item.file) ||
      item.file !== item.id + '.' + item.ext
    )
      throw Error('原件路径无效');
    return path.join(this.root, 'originals', item.file);
  }
  discard(ids, trashFile) {
    return this.run(async () => {
      const wanted = new Set(ids),
        previous = this.data,
        removed = new Set(),
        failed = [],
        active = new Set(previous.items.map((item) => item.id));
      const recovery = path.join(this.root, 'recovery');
      await fs.mkdir(recovery, { recursive: true });
      const recoveryFile = path.join(
        recovery,
        'before-trash-discard-' + Date.now() + '-' + crypto.randomUUID() + '.json',
      );
      await fs.writeFile(recoveryFile, JSON.stringify(previous), { mode: 0o600, flag: 'wx' });
      for (const item of previous.trash || []) {
        if (!wanted.has(item.id)) continue;
        try {
          if (!active.has(item.id)) await trashFile(this.originalPath(item));
          removed.add(item.id);
        } catch (error) {
          failed.push({ id: item.id, name: item.name, error: error.message });
        }
      }
      this.data = {
        ...previous,
        trash: (previous.trash || []).filter((item) => !removed.has(item.id)),
      };
      try {
        await this.save();
      } catch (error) {
        this.data = previous;
        throw Error(
          '原件已交给系统废纸篓，但记录未保存；重启后可能需要重新清理记录。' + error.message,
        );
      }
      return { removed: removed.size, failed, recoveryFile };
    });
  }
}
module.exports = { Library, identify, gifFrames };
