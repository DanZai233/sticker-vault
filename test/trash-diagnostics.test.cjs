const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { Library } = require('../src/library.cjs');
const { readReport } = require('../src/import-diagnostics.cjs');
const { exportBackup, stageBackup, mergeStaged } = require('../src/backup.cjs');
const { connectorHelp } = require('../src/diagnostic-help.js');
const image = path.join(__dirname, 'fixtures/ocr-text.png');
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vault-trash-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const lib = await new Library(path.join(root, 'vault')).init();
  await lib.import([image]);
  return { root, lib, id: lib.data.items[0].id };
}
test('soft delete and restart retain exact originals, metadata and OCR; batch restoration is idempotent', async (t) => {
  const { root, lib, id } = await fixture(t);
  await lib.update(id, { name: '保留名字', favorite: true, tags: ['手动标签'] });
  lib.data.ocrRecords = {
    [id]: { status: 'done', text: '文字', tags: ['OCR标签'], finishedAt: 1 },
  };
  await lib.save();
  const before = await fs.readFile(path.join(lib.root, 'originals', lib.data.items[0].file));
  const result = await lib.remove([id]);
  assert.equal(result.count, 1);
  assert.equal(lib.data.items.length, 0);
  assert.equal(lib.data.trash.length, 1);
  const reload = await new Library(lib.root).init();
  assert.deepEqual(
    await fs.readFile(path.join(reload.root, 'originals', reload.data.trash[0].file)),
    before,
  );
  assert.equal(reload.data.trash[0].favorite, true);
  assert.equal((await reload.restore([id])).restored, 1);
  assert.equal((await reload.restore([id])).restored, 0);
  assert.deepEqual(reload.data.items[0].tags, ['手动标签']);
  assert.equal(reload.data.items[0].ocrText, '文字');
  assert.equal(reload.data.trash.length, 0);
});
test('automatic collection leaves trashed content alone while manual reimport restores it', async (t) => {
  const { lib, id } = await fixture(t);
  await lib.update(id, { tags: ['保留'] });
  await lib.remove([id]);
  const automatic = await lib.import([image], 'QQ', { restoreTrash: false, automatic: true });
  assert.equal(automatic.skipped, 1);
  assert.equal(lib.data.items.length, 0);
  assert.equal(lib.data.trash.length, 1);
  const manual = await lib.import([image]);
  assert.equal(manual.restored, 1);
  assert.equal(manual.added, 0);
  assert.deepEqual(lib.data.items[0].tags, ['保留']);
  assert.equal(lib.data.trash.length, 0);
});
test('delete/restore save failures do not alter live membership; inaccessible originals stay in bin', async (t) => {
  const { lib, id } = await fixture(t),
    save = lib.save.bind(lib);
  lib.save = async () => {
    throw Error('disk full');
  };
  await assert.rejects(lib.remove([id]), /disk full/);
  assert.equal(lib.data.items.length, 1);
  assert.equal(lib.data.trash.length, 0);
  lib.save = save;
  await lib.remove([id]);
  lib.save = async () => {
    throw Error('disk full');
  };
  await assert.rejects(lib.restore([id]), /disk full/);
  assert.equal(lib.data.items.length, 0);
  assert.equal(lib.data.trash.length, 1);
  lib.save = save;
  await fs.unlink(path.join(lib.root, 'originals', lib.data.trash[0].file));
  const result = await lib.restore([id]);
  assert.equal(result.failed.length, 1);
  assert.equal(lib.data.trash.length, 1);
});
test('discard uses the injected system trash operation, preserves failed entries and keeps a recovery point', async (t) => {
  const { root, lib, id } = await fixture(t);
  await lib.remove([id]);
  const failed = await lib.discard([id], async () => {
    throw Error('system trash unavailable');
  });
  assert.equal(failed.failed.length, 1);
  assert.equal(lib.data.trash.length, 1);
  const result = await lib.discard([id], async (file) =>
    fs.rename(file, path.join(root, 'system-trash.png')),
  );
  assert.equal(result.removed, 1);
  assert.equal(lib.data.trash.length, 0);
  assert.ok((await fs.stat(result.recoveryFile)).size > 0);
  assert.deepEqual(
    await fs.readFile(path.join(root, 'system-trash.png')),
    await fs.readFile(image),
  );
});
test('manual backup merge restores a matching trashed item without two records or losing local edits', async (t) => {
  const { root, lib, id } = await fixture(t),
    archive = path.join(root, 'active.zip');
  await exportBackup(lib, archive);
  await lib.update(id, { name: '新名字', favorite: true });
  await lib.remove([id]);
  const staged = await stageBackup(archive);
  try {
    await mergeStaged(lib, staged);
  } finally {
    await staged.cleanup();
  }
  assert.equal(lib.data.items.length, 1);
  assert.equal(lib.data.trash.length, 0);
  assert.equal(lib.data.items[0].name, '新名字');
  assert.equal(lib.data.items[0].favorite, true);
});
test('diagnostics classify added, duplicate, unsupported, empty, oversized and missing paths without aborting healthy imports', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vault-report-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const lib = await new Library(path.join(root, 'vault')).init(),
    valid = path.join(root, 'valid.png'),
    duplicate = path.join(root, 'same.dat'),
    unsupported = path.join(root, 'notes.txt'),
    empty = path.join(root, 'empty.gif'),
    large = path.join(root, 'large.png'),
    missing = path.join(root, 'missing');
  await fs.copyFile(image, valid);
  await fs.copyFile(image, duplicate);
  await fs.writeFile(unsupported, 'not an image');
  await fs.writeFile(empty, '');
  const file = await fs.open(large, 'w');
  await file.truncate(100 * 1024 * 1024 + 1);
  await file.close();
  const result = await lib.import([valid, duplicate, unsupported, empty, large, missing]);
  assert.equal(result.added, 1);
  assert.equal(result.duplicates, 1);
  assert.equal(result.skipped, 3);
  assert.equal(result.failed, 1);
  const report = await readReport(lib, result.reportId);
  assert.deepEqual(report.reasons, {
    missing: 1,
    empty: 1,
    too_large: 1,
    added: 1,
    duplicate: 1,
    unsupported: 1,
  });
  assert.equal(report.details.length, 6);
  await assert.rejects(readReport(lib, '../../outside'), /无效/);
});
test('permission failures are reported per path and report retention stays bounded', async (t) => {
  const { root, lib } = await fixture(t),
    locked = path.join(root, 'locked'),
    lstat = fs.lstat.bind(fs);
  t.mock.method(fs, 'lstat', async (file) => {
    if (file === locked) {
      const error = Error('denied');
      error.code = 'EACCES';
      throw error;
    }
    return lstat(file);
  });
  const result = await lib.import([locked, image]);
  const report = await readReport(lib, result.reportId);
  assert.equal(report.reasons.permission, 1);
  assert.equal(result.duplicates, 1);
  for (let i = 0; i < 22; i++) await lib.import([image]);
  assert.equal(lib.data.importReports.length, 20);
  assert.equal(
    (await fs.readdir(path.join(lib.root, 'reports'))).filter((file) => file.endsWith('.json'))
      .length,
    20,
  );
});
test('platform advice distinguishes Windows WeChat 4.x, QQ NT, macOS helper and Linux limitations', () => {
  assert.match(connectorHelp('wechat', 'win32').join(' '), /4.x/);
  assert.match(connectorHelp('wechat', 'win32').join(' '), /xwechat_files/);
  assert.ok(!connectorHelp('wechat', 'win32').join(' ').includes('助手缓存'));
  assert.match(connectorHelp('wechat', 'darwin').join(' '), /副本/);
  assert.match(connectorHelp('wechat', 'linux').join(' '), /暂不支持/);
  assert.match(connectorHelp('qq', 'win32').join(' '), /Ori/);
  assert.match(connectorHelp('douyin', 'darwin').join(' '), /白屏/);
});
