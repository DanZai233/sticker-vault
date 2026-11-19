const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const fss = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { pipeline } = require('node:stream/promises');
const yazl = require('yazl');
const { Library } = require('../src/library.cjs');
const { exportBackup, stageBackup, mergeStaged, snapshotManifest } = require('../src/backup.cjs');
const frame = Buffer.from('21f904000a0000002c0000000001000100000202440100', 'hex');
const gif = Buffer.concat([
  Buffer.from('47494638396101000100800000000000ffffff', 'hex'),
  frame,
  frame,
  Buffer.from([0x3b]),
]);
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sticker-portable-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const lib = await new Library(path.join(root, 'library')).init();
  const image = path.join(root, 'image.gif');
  await fs.writeFile(image, gif);
  await lib.import([image]);
  return { root, lib, id: lib.data.items[0].id };
}
async function zip(file, entries) {
  const value = new yazl.ZipFile();
  for (const [name, bytes] of entries) value.addBuffer(Buffer.from(bytes), name);
  const writing = pipeline(value.outputStream, fss.createWriteStream(file));
  value.end();
  await writing;
}
test('portable backup roundtrips byte-exact animation, metadata, once-only OCR and settings without credentials or activating foreign paths', async (t) => {
  const { root, lib, id } = await fixture(t);
  await lib.update(id, { name: '开心', tags: ['猫猫'], favorite: true });
  await lib.moveToFront(id);
  lib.data.settings = { ocrEnabled: false };
  lib.data.settingsUpdatedAt = { ocrEnabled: 100 };
  lib.data.folders = [{ path: 'C:\\Users\\test\\表情', source: 'QQ' }];
  lib.data.connectors = { qq: { enabled: true, base: 'C:\\QQ', password: 'never-export-this' } };
  lib.data.ocrRecords = {
    [id]: { status: 'done', text: '好开心', tags: ['开心'], finishedAt: 20 },
  };
  await lib.save();
  const file = path.join(root, 'backup.zip');
  await exportBackup(lib, file, {
    config: {
      startupRequested: true,
      webdav: { url: 'https://example.test/dav/', username: 'test', password: 'never-export-this' },
    },
  });
  const staged = await stageBackup(file);
  t.after(() => staged.cleanup());
  assert.ok(!JSON.stringify(staged.manifest).includes('never-export-this'));
  const target = await new Library(path.join(root, 'target')).init();
  const result = await mergeStaged(target, staged);
  assert.equal(result.added, 1);
  assert.equal(target.data.items[0].name, '开心');
  assert.equal(target.data.items[0].favorite, true);
  assert.equal(target.data.items[0].animated, true);
  assert.equal(target.data.items[0].ocrText, '好开心');
  assert.equal(target.data.settings.ocrEnabled, false);
  assert.deepEqual(target.data.folders, []);
  assert.equal(target.data.connectors, undefined);
  assert.equal(target.data.migrationHints.folders[0].path, 'C:\\Users\\test\\表情');
  assert.equal(target.data.migrationHints.startupRequested, true);
  assert.deepEqual(
    await fs.readFile(path.join(target.root, 'originals', target.data.items[0].file)),
    gif,
  );
  assert.ok((await fs.stat(result.recoveryFile)).size > 0);
  await mergeStaged(target, staged);
  assert.equal(target.data.items.length, 1);
});
test('empty and older backup cannot erase existing images, newer explicit edits or OCR records', async (t) => {
  const { root, lib, id } = await fixture(t);
  await lib.update(id, { tags: ['保留'], favorite: true });
  const older = snapshotManifest(lib);
  await lib.update(id, { tags: [], favorite: false });
  lib.data.items[0].fieldUpdatedAt.tags += 100;
  lib.data.items[0].fieldUpdatedAt.favorite += 100;
  lib.data.ocrRecords = { [id]: { status: 'done', text: '唯一识别', tags: [], finishedAt: 20 } };
  await lib.save();
  const empty = new Library(path.join(root, 'empty'));
  await empty.init();
  const file = path.join(root, 'empty.zip');
  await exportBackup(empty, file);
  const staged = await stageBackup(file);
  try {
    await mergeStaged(lib, staged);
  } finally {
    await staged.cleanup();
  }
  assert.equal(lib.data.items.length, 1);
  assert.equal(lib.data.ocrRecords[id].text, '唯一识别');
  const oldFile = path.join(root, 'old.zip');
  await zip(oldFile, [
    ['manifest.json', JSON.stringify(older)],
    ['originals/' + older.items[0].file, gif],
  ]);
  const old = await stageBackup(oldFile);
  try {
    await mergeStaged(lib, old);
  } finally {
    await old.cleanup();
  }
  assert.deepEqual(lib.data.items[0].tags, []);
  assert.equal(lib.data.items[0].favorite, false);
});
test('corrupt, incomplete and traversal archives never modify the destination library', async (t) => {
  const { root, lib } = await fixture(t);
  const before = JSON.stringify(lib.data),
    manifest = snapshotManifest(lib),
    file = path.join(root, 'bad.zip');
  await zip(file, [['manifest.json', JSON.stringify(manifest)]]);
  await assert.rejects(stageBackup(file), /数量|缺少/);
  await zip(file, [
    ['manifest.json', JSON.stringify(manifest)],
    ['originals/' + manifest.items[0].file, Buffer.from('bad image')],
  ]);
  await assert.rejects(stageBackup(file), /校验/);
  await exportBackup(lib, file);
  let bytes = await fs.readFile(file);
  bytes = Buffer.from(bytes.toString('latin1').replaceAll('originals/', '../escape/'), 'latin1');
  await fs.writeFile(file, bytes);
  await assert.rejects(stageBackup(file), /路径|relative|invalid/i);
  assert.equal(JSON.stringify(lib.data), before);
  assert.deepEqual(
    await fs.readFile(path.join(lib.root, 'originals', manifest.items[0].file)),
    gif,
  );
});
test('export refuses a missing original and does not replace an existing backup', async (t) => {
  const { root, lib } = await fixture(t),
    file = path.join(root, 'existing.zip');
  await fs.writeFile(file, 'preserve old backup');
  await fs.unlink(path.join(lib.root, 'originals', lib.data.items[0].file));
  await assert.rejects(exportBackup(lib, file));
  assert.equal(await fs.readFile(file, 'utf8'), 'preserve old backup');
});
module.exports = { gif };
test('failed metadata commit keeps the live library unchanged and preserves a recovery snapshot', async (t) => {
  const { root, lib } = await fixture(t),
    file = path.join(root, 'backup.zip');
  await exportBackup(lib, file);
  const staged = await stageBackup(file);
  t.after(() => staged.cleanup());
  const target = await new Library(path.join(root, 'target-failure')).init(),
    before = structuredClone(target.data);
  target.save = async () => {
    throw Error('simulated full disk');
  };
  await assert.rejects(mergeStaged(target, staged), /full disk/);
  assert.deepEqual(target.data, before);
  assert.equal((await fs.readdir(path.join(target.root, 'recovery'))).length, 1);
});
