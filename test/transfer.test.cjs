const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { Library } = require('../src/library.cjs');
const { Transfers } = require('../src/transfer.cjs');
const { exportBackup } = require('../src/backup.cjs');
test('canceling import preview does not change images or config; controller serializes manual operations', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sticker-transfer-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const lib = await new Library(path.join(root, 'vault')).init();
  await lib.import([path.join(__dirname, 'fixtures/ocr-text.png')]);
  const file = path.join(root, 'archive.zip');
  await exportBackup(lib, file);
  const events = [];
  const transfers = await new Transfers(lib, {
    root,
    safeStorage: { isEncryptionAvailable: () => false },
    notify: (value) => events.push(value),
  }).init();
  const before = JSON.stringify(lib.data);
  const result = await transfers.import(file, async () => null);
  assert.equal(result.canceled, true);
  assert.equal(JSON.stringify(lib.data), before);
  assert.equal(transfers.status.busy, false);
  assert.equal(events.at(-1).transfer.phase, 'done');
  let finish;
  const pending = transfers.run(
    'test',
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  await assert.rejects(
    transfers.run('sync', () => {}),
    /正在进行/,
  );
  await assert.rejects(transfers.save({ url: 'https://example.test/dav/' }), /等待/);
  finish({ message: 'done' });
  await pending;
});
