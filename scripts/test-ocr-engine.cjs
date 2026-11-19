const { app, utilityProcess } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const { OcrRunner } = require('../src/ocr-runner.cjs');
const { OcrImageExtractor } = require('../src/ocr-image.cjs');
const { Library } = require('../src/library.cjs');
const { OcrQueue } = require('../src/ocr.cjs');
if (process.env.CI && process.platform === 'linux') app.commandLine.appendSwitch('no-sandbox');
app.disableHardwareAcceleration();
let root, runner, extractor;
(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'sticker-real-ocr-'));
  app.setPath('userData', path.join(root, 'profile'));
  await app.whenReady();
  try {
    const packaged = process.env.STICKER_PACKAGED_RESOURCES;
    // Fixed raster fixture avoids differences in the host OS's fallback fonts.
    extractor = new OcrImageExtractor();
    const input = path.join(__dirname, '../test/fixtures/ocr-text.png');
    runner = new OcrRunner({
      modelsPath: packaged
        ? path.join(packaged, 'ocr-data')
        : path.join(__dirname, '../vendor/ocr-data'),
      hostPath: packaged
        ? path.join(packaged, 'app.asar.unpacked/src/ocr-host.cjs')
        : path.join(__dirname, '../src/ocr-host.cjs'),
      spawnHost: (host) =>
        utilityProcess.fork(host, [], { serviceName: 'OCR integration fixture', stdio: 'pipe' }),
    });
    let calls = 0;
    const recognize = runner.recognize.bind(runner);
    runner.recognize = async (image) => {
      calls++;
      return recognize(image);
    };
    const lib = await new Library(path.join(root, 'library')).init();
    await lib.import([input]);
    const original = await fs.readFile(path.join(lib.root, 'originals', lib.data.items[0].file));
    const queue = await new OcrQueue(lib, {
      engine: runner,
      prepareImage: (file) => extractor.read(file),
      schedule: false,
    }).init();
    assert.equal(await queue.runOne(), true);
    const record = lib.data.ocrRecords[lib.data.items[0].id];
    assert.equal(record.status, 'done', record.error);
    assert.match(record.text, /HELLO/i);
    assert.match(record.text, /STICKER/i);
    assert.ok(record.tags.length > 0);
    assert.equal(await queue.runOne(), false);
    assert.equal(calls, 1);
    assert.deepEqual(
      await fs.readFile(path.join(lib.root, 'originals', lib.data.items[0].file)),
      original,
    );
    const frame = Buffer.from('21f904000a0000002c0000000001000100000202440100', 'hex');
    const gif = Buffer.concat([
      Buffer.from('47494638396101000100800000000000ffffff', 'hex'),
      frame,
      frame,
      Buffer.from([0x3b]),
    ]);
    const animatedInput = path.join(root, 'animated.gif');
    await fs.writeFile(animatedInput, gif);
    await lib.import([animatedInput]);
    const animatedItem = lib.data.items.find((item) => item.animated);
    assert.ok(animatedItem);
    assert.equal(await queue.runOne(), true);
    assert.equal(lib.data.ocrRecords[animatedItem.id].status, 'done');
    assert.deepEqual(await fs.readFile(path.join(lib.root, 'originals', animatedItem.file)), gif);
    assert.equal(await queue.runOne(), false);
    assert.equal(calls, 2);
    console.log(
      'REAL_OCR_PASS: offline Chinese/English engine, isolated utility worker, image preprocessing, automatic tags, once-only and byte-preserved original',
    );
    queue.stop();
    extractor.stop();
    app.quit();
  } catch (e) {
    console.error(e);
    runner?.stop();
    extractor?.stop();
    app.exit(1);
  }
})().catch((e) => {
  console.error(e);
  app.exit(1);
});
app.on('will-quit', () => {
  if (root)
    try {
      require('node:fs').rmSync(root, { recursive: true, force: true });
    } catch {}
});
