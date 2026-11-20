const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { Library } = require('../src/library.cjs');
const { OcrQueue, tagsFromText } = require('../src/ocr.cjs');
async function fixture(run) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sticker-ocr-'));
  try {
    const lib = await new Library(path.join(root, 'vault')).init();
    const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
    const image = path.join(root, 'meme.png');
    await fs.writeFile(image, png);
    await lib.import([image]);
    await run({ root, lib, image });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}
const engine = (recognize) => ({ prepare: async () => {}, recognize, stop: () => {} });
test('OCR persists no-text completion and never repeats after restart or duplicate import', () =>
  fixture(async ({ lib, image }) => {
    let count = 0;
    let queue = await new OcrQueue(lib, {
      engine: engine(async () => {
        count++;
        return { text: '', confidence: 0 };
      }),
      prepareImage: async () => Buffer.from('fixture'),
      schedule: false,
    }).init();
    assert.equal(await queue.runOne(), true);
    assert.equal(await queue.runOne(), false);
    assert.equal(count, 1);
    const reloaded = await new Library(lib.root).init();
    queue = await new OcrQueue(reloaded, {
      engine: engine(async () => {
        count++;
        return { text: 'wrong' };
      }),
      prepareImage: async () => Buffer.from('fixture'),
      schedule: false,
    }).init();
    await reloaded.import([image]);
    assert.equal(await queue.runOne(), false);
    assert.equal(count, 1);
    assert.equal(reloaded.data.ocrRecords[reloaded.data.items[0].id].status, 'done');
  }));
test('OCR merges automatic tags into current manual edits and restores deleted/reimported content without recognition', () =>
  fixture(async ({ lib, image }) => {
    let count = 0;
    const id = lib.data.items[0].id;
    const queue = await new OcrQueue(lib, {
      engine: engine(async () => {
        count++;
        await lib.update(id, { tags: ['自定义'] });
        return { text: '今天不上班', confidence: 90 };
      }),
      prepareImage: async () => Buffer.from('fixture'),
      schedule: false,
    }).init();
    await queue.runOne();
    assert.ok(lib.data.items[0].tags.includes('自定义'));
    assert.ok(lib.data.items[0].tags.includes('今天不上班'));
    assert.equal(count, 1);
    await lib.update(id, { tags: ['自定义'] });
    const reload = await new Library(lib.root).init();
    await new OcrQueue(reload, {
      engine: engine(async () => {}),
      prepareImage: async () => {},
      schedule: false,
    }).init();
    assert.deepEqual(
      reload.data.items[0].tags,
      ['自定义'],
      'restart does not re-add a removed automatic tag',
    );
    await reload.remove([id]);
    await reload.import([image]);
    assert.deepEqual(
      reload.data.items[0].tags,
      ['自定义'],
      'restoring a soft-deleted image preserves manual removal of OCR tags',
    );
    assert.equal(count, 1);
    assert.equal(
      await new OcrQueue(reload, {
        engine: engine(async () => {
          count++;
        }),
        prepareImage: async () => {},
        schedule: false,
      }).runOne(),
      false,
    );
  }));
test('OCR pause persists and job failures are terminal, while engine initialization failures do not consume an image', () =>
  fixture(async ({ lib }) => {
    let calls = 0;
    const q = await new OcrQueue(lib, {
      engine: engine(async () => {
        calls++;
        throw Error('bad image');
      }),
      prepareImage: async () => Buffer.from('fixture'),
      schedule: false,
    }).init();
    await q.setEnabled(false);
    assert.equal(await q.runOne(), false);
    assert.equal(calls, 0);
    assert.equal((await new Library(lib.root).init()).data.settings.ocrEnabled, false);
    await q.setEnabled(true);
    assert.equal(await q.runOne(), true);
    assert.equal(await q.runOne(), false);
    assert.equal(calls, 1);
    assert.equal(q.summary().failed, 1);
    const lib2 = await new Library(path.join(lib.root, 'other')).init();
    lib2.data.items = [{ id: 'other', file: 'x', tags: [] }];
    const bad = await new OcrQueue(lib2, {
      engine: {
        prepare: async () => {
          throw Error('model missing');
        },
        stop: () => {},
      },
      prepareImage: async () => {},
      schedule: false,
    }).init();
    await bad.runOne();
    assert.equal(Object.keys(lib2.data.ocrRecords).length, 0);
    assert.match(bad.summary().error, /model missing/);
  }));
test('OCR claims an image before recognition, prevents overlapping jobs and marks interrupted work without retry', () =>
  fixture(async ({ lib }) => {
    let complete, started;
    const entered = new Promise((r) => (started = r)),
      pending = new Promise((r) => (complete = r));
    let count = 0;
    const q = await new OcrQueue(lib, {
      engine: engine(async () => {
        count++;
        const onDisk = await new Library(lib.root).init();
        assert.equal(onDisk.data.ocrRecords[lib.data.items[0].id].status, 'processing');
        started();
        return pending;
      }),
      prepareImage: async () => Buffer.from('fixture'),
      schedule: false,
    }).init();
    const job = q.runOne();
    await entered;
    assert.equal(await q.runOne(), false);
    complete({ text: '收到', confidence: 80 });
    await job;
    assert.equal(count, 1);
    const id = lib.data.items[0].id;
    lib.data.ocrRecords[id].status = 'processing';
    await lib.save();
    const reload = await new Library(lib.root).init();
    const q2 = await new OcrQueue(reload, {
      engine: engine(async () => {
        count++;
      }),
      prepareImage: async () => {},
      schedule: false,
    }).init();
    assert.equal(reload.data.ocrRecords[id].status, 'interrupted');
    assert.equal(await q2.runOne(), false);
    assert.equal(count, 1);
  }));
test('OCR tags are bounded, deduplicated, confidence-gated and searchable phrases survive punctuation cleanup', () => {
  const r = tagsFromText('你好，世界！\n你好\n今天不上班\nhello world', 90);
  assert.ok(r.tags.includes('今天不上班'));
  assert.equal(new Set(r.tags.map((t) => t.toLowerCase())).size, r.tags.length);
  assert.ok(r.tags.length <= 8);
  assert.deepEqual(tagsFromText('看不清', 5).tags, []);
  assert.equal(tagsFromText('x'.repeat(10000)).text.length, 4000);
});
