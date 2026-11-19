const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
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
  async collect(paths) {
    const out = [];
    const walk = async (p, depth) => {
      if (depth > 12) return;
      const s = await fs.stat(p);
      if (s.isDirectory()) {
        for (const name of await fs.readdir(p)) {
          if (!name.startsWith('.')) await walk(path.join(p, name), depth + 1);
        }
      } else if (s.isFile() && s.size <= 100 * 1024 * 1024) out.push(p);
    };
    for (const p of paths) await walk(p, 0);
    return out;
  }
  import(paths, source = '本地导入') {
    return this.run(async () => {
      let added = 0,
        duplicates = 0,
        skipped = 0;
      const errors = [];
      for (const p of await this.collect(paths)) {
        try {
          const b = await fs.readFile(p);
          const type = identify(b);
          if (!type) {
            skipped++;
            continue;
          }
          const id = crypto.createHash('sha256').update(b).digest('hex');
          if (this.data.items.some((i) => i.id === id)) {
            duplicates++;
            continue;
          }
          const file = id + '.' + type.ext;
          await fs.writeFile(path.join(this.root, 'originals', file), b);
          this.data.items.unshift({
            id,
            file,
            name: path.parse(p).name,
            ...type,
            size: b.length,
            source,
            tags: [],
            favorite: false,
            createdAt: Date.now(),
          });
          added++;
        } catch (e) {
          errors.push(path.basename(p) + ': ' + e.message);
        }
      }
      await this.save();
      return { added, duplicates, skipped, errors };
    });
  }
  update(id, patch) {
    return this.run(async () => {
      const item = this.data.items.find((i) => i.id === id);
      if (!item) throw Error('表情不存在');
      for (const key of ['name', 'tags', 'favorite', 'lastUsedAt', 'useCount'])
        if (key in patch) item[key] = patch[key];
      await this.save();
    });
  }
  remove(ids) {
    return this.run(async () => {
      const items = this.data.items.filter((i) => ids.includes(i.id));
      this.data.items = this.data.items.filter((i) => !ids.includes(i.id));
      await this.save();
      for (const i of items)
        await fs.unlink(path.join(this.root, 'originals', i.file)).catch(() => {});
    });
  }
}
module.exports = { Library, identify, gifFrames };
