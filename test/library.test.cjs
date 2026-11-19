const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { Library, identify } = require('../src/library.cjs');
// Two complete GIF image blocks. This fixture is decoded by the desktop smoke test too.
const frame = Buffer.from('21f904000a0000002c0000000001000100000202440100', 'hex');
const gif = Buffer.concat([
  Buffer.from('47494638396101000100800000000000ffffff', 'hex'),
  frame,
  frame,
  Buffer.from([0x3b]),
]);
test('animated GIF classification and byte-exact persistence, deduplication, metadata and reload', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vault-test-'));
  try {
    const src = path.join(root, 'input');
    await fs.mkdir(src);
    await fs.writeFile(path.join(src, 'dance.gif'), gif);
    await fs.writeFile(path.join(src, 'duplicate.dat'), gif);
    await fs.writeFile(path.join(src, 'ignored.txt'), 'hello');
    const lib = await new Library(path.join(root, 'vault')).init();
    assert.deepEqual(identify(gif), { ext: 'gif', animated: true });
    const r = await lib.import([src], '微信');
    assert.equal(r.added, 1);
    assert.equal(r.duplicates, 1);
    assert.equal(r.skipped, 1);
    const i = lib.data.items[0];
    assert.equal(i.animated, true);
    assert.deepEqual(await fs.readFile(path.join(lib.root, 'originals', i.file)), gif);
    await lib.update(i.id, { name: '测试', tags: ['开心'], favorite: true });
    const reload = await new Library(lib.root).init();
    assert.equal(reload.data.items[0].favorite, true);
    assert.deepEqual(reload.data.items[0].tags, ['开心']);
    await reload.remove([i.id]);
    assert.equal(reload.data.items.length, 0);
    assert.deepEqual(await fs.readFile(path.join(src, 'dance.gif')), gif);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
test('concurrent imports are serialized, preserving one original', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vault-race-'));
  try {
    const p = path.join(root, 'x.gif');
    await fs.writeFile(p, gif);
    const lib = await new Library(path.join(root, 'vault')).init();
    await Promise.all([lib.import([p]), lib.import([p])]);
    assert.equal(lib.data.items.length, 1);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
test('move-to-front is repeatable ordering, preserves favorite metadata and survives reload', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vault-order-'));
  try {
    const lib = await new Library(root).init();
    lib.data.items = [
      { id: 'a', name: 'A', favorite: true, createdAt: 300 },
      { id: 'b', name: 'B', favorite: false, createdAt: 200 },
      { id: 'c', name: 'C', favorite: false, createdAt: 100 },
    ];
    await lib.save();
    await lib.moveToFront('c');
    const firstOrder = lib.data.items[0].moveOrderAt;
    assert.deepEqual(
      lib.data.items.map((i) => i.id),
      ['c', 'a', 'b'],
    );
    await lib.moveToFront('c');
    assert.deepEqual(
      lib.data.items.map((i) => i.id),
      ['c', 'a', 'b'],
    );
    assert.ok(lib.data.items[0].moveOrderAt > firstOrder);
    await lib.moveToFront('b');
    const reload = await new Library(root).init();
    assert.deepEqual(
      reload.data.items.map((i) => i.id),
      ['b', 'c', 'a'],
    );
    assert.equal(reload.data.items.find((i) => i.id === 'a').favorite, true);
    await assert.rejects(reload.moveToFront('missing'), /不存在/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
