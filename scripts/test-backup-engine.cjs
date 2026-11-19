const { app, safeStorage } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const assert = require('node:assert/strict');
app.disableHardwareAcceleration();
if (process.env.CI && process.platform === 'linux') app.commandLine.appendSwitch('no-sandbox');
let root, server;
(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'sticker-transfer-engine-'));
  app.setPath('userData', path.join(root, 'profile'));
  await app.whenReady();
  const resources = process.env.STICKER_PACKAGED_RESOURCES,
    base = resources ? path.join(resources, 'app.asar/src') : path.join(__dirname, '../src');
  const { Library } = require(path.join(base, 'library.cjs')),
    { Transfers } = require(path.join(base, 'transfer.cjs'));
  let remote = null,
    revision = 0;
  const probes = new Set();
  server = http.createServer(async (req, res) => {
    try {
      const canonical = req.url === '/dav/stickervault-v1.zip';
      if (req.method === 'PROPFIND') {
        res.writeHead(207);
        res.end();
        return;
      }
      if (req.method === 'DELETE') {
        probes.delete(req.url);
        res.writeHead(204);
        res.end();
        return;
      }
      if (req.method === 'GET') {
        if (!remote) {
          res.writeHead(404);
          res.end();
          return;
        }
        res.writeHead(200, { ETag: '"' + revision + '"', 'Content-Length': remote.length });
        res.end(remote);
        return;
      }
      if (req.method === 'PUT') {
        const exists = canonical ? !!remote : probes.has(req.url);
        if (
          (req.headers['if-none-match'] === '*' && exists) ||
          (req.headers['if-match'] && (!exists || req.headers['if-match'] !== '"' + revision + '"'))
        ) {
          res.writeHead(412);
          res.end();
          req.resume();
          return;
        }
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        if (canonical) {
          remote = Buffer.concat(chunks);
          revision++;
        } else probes.add(req.url);
        res.writeHead(201);
        res.end();
        return;
      }
      res.writeHead(405);
      res.end();
    } catch (error) {
      res.writeHead(500);
      res.end(error.message);
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}/dav/`;
  const frame = Buffer.from('21f904000a0000002c0000000001000100000202440100', 'hex');
  const gif = Buffer.concat([
    Buffer.from('47494638396101000100800000000000ffffff', 'hex'),
    frame,
    frame,
    Buffer.from([0x3b]),
  ]);
  const input = path.join(root, 'animated.gif');
  await fs.writeFile(input, gif);
  const a = await new Library(path.join(root, 'source/vault')).init();
  await a.import([input, path.join(__dirname, '../test/fixtures/ocr-text.png')]);
  const id = a.data.items.find((i) => i.animated).id;
  await a.update(id, { favorite: true, tags: ['跨平台'] });
  await a.moveToFront(id);
  const first = await new Transfers(a, { root: path.join(root, 'source'), safeStorage }).init();
  const file = path.join(root, 'portable.zip');
  await first.export(file);
  const b = await new Library(path.join(root, 'target/vault')).init(),
    second = await new Transfers(b, { root: path.join(root, 'target'), safeStorage }).init();
  await second.import(file, async (manifest) => {
    assert.equal(manifest.items.length, 2);
    return { restoreSettings: true };
  });
  assert.equal(b.data.items.length, 2);
  assert.equal(b.data.items.find((i) => i.id === id).favorite, true);
  assert.deepEqual(
    await fs.readFile(path.join(b.root, 'originals', b.data.items.find((i) => i.id === id).file)),
    gif,
  );
  await first.save({ url, username: '', password: '' });
  assert.equal(remote, null);
  await first.test();
  assert.equal(probes.size, 0);
  assert.equal(remote, null);
  await first.sync();
  const c = await new Library(path.join(root, 'empty-device/vault')).init(),
    third = await new Transfers(c, { root: path.join(root, 'empty-device'), safeStorage }).init();
  await third.save({ url, username: '', password: '' });
  await third.sync();
  assert.equal(c.data.items.length, 2);
  assert.deepEqual(
    await fs.readFile(path.join(c.root, 'originals', c.data.items.find((i) => i.id === id).file)),
    gif,
  );
  assert.equal(probes.size, 0);
  console.log(
    'TRANSFER_ENGINE_PASS: real Electron storage, full ZIP migration, byte-exact GIF, explicit local WebDAV sync, empty-device protection and bundled dependencies',
  );
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  server = null;
  await fs.rm(root, { recursive: true, force: true });
  root = null;
  app.exit(0);
})().catch(async (error) => {
  console.error(error);
  server?.closeAllConnections();
  server?.close();
  if (root) await fs.rm(root, { recursive: true, force: true }).catch(() => {});
  app.exit(1);
});
