const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { Library } = require('../src/library.cjs');
const { DavSettings, WebDavSync, normalizeUrl } = require('../src/webdav.cjs');
const { exportBackup, stageBackup } = require('../src/backup.cjs');
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sticker-sync-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}
async function davServer(t, { brokenConditions = false, noEtag = false } = {}) {
  let archive = null,
    revision = 0,
    puts = 0;
  const probes = new Map(),
    requests = [];
  let forcedConflict = null;
  const server = http.createServer(async (req, res) => {
    try {
      requests.push({ method: req.method, url: req.url });
      const canonical = req.url === '/dav/stickervault-v1.zip';
      if (req.method === 'PROPFIND') {
        res.writeHead(207);
        return res.end('<multistatus/>');
      }
      if (req.method === 'MKCOL') {
        res.writeHead(201);
        return res.end();
      }
      if (req.method === 'DELETE') {
        probes.delete(req.url);
        res.writeHead(204);
        return res.end();
      }
      if (req.method === 'GET') {
        if (!canonical || !archive) {
          res.writeHead(404);
          return res.end();
        }
        res.writeHead(200, {
          'Content-Length': archive.length,
          ...(noEtag ? {} : { ETag: '"' + revision + '"' }),
        });
        return res.end(archive);
      }
      if (req.method === 'PUT') {
        if (canonical && forcedConflict) {
          archive = forcedConflict;
          forcedConflict = null;
          revision++;
        }
        const exists = canonical ? !!archive : probes.has(req.url),
          etag = '"' + revision + '"';
        if (
          !brokenConditions &&
          ((req.headers['if-none-match'] === '*' && exists) ||
            (req.headers['if-match'] && (!exists || req.headers['if-match'] !== etag)))
        ) {
          res.writeHead(412);
          res.end();
          req.resume();
          return;
        }
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        const bytes = Buffer.concat(chunks);
        if (canonical) {
          archive = bytes;
          revision++;
          puts++;
        } else probes.set(req.url, bytes);
        res.writeHead(201, { ETag: '"' + revision + '"' });
        return res.end();
      }
      res.writeHead(405);
      res.end();
    } catch (error) {
      res.writeHead(500);
      res.end(error.message);
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(
    () =>
      new Promise((resolve) => {
        server.close(resolve);
        server.closeAllConnections();
      }),
  );
  return {
    url: `http://127.0.0.1:${server.address().port}/dav/`,
    requests,
    get archive() {
      return archive;
    },
    set archive(v) {
      archive = v;
      revision++;
    },
    get puts() {
      return puts;
    },
    get probes() {
      return probes.size;
    },
    conflict(v) {
      forcedConflict = v;
    },
  };
}
async function client(root, name, url) {
  const lib = await new Library(path.join(root, name, 'vault')).init();
  const settings = await new DavSettings(path.join(root, name), {
    isEncryptionAvailable: () => false,
  }).init();
  await settings.save({ url, username: 'test', password: 'secret' });
  return { lib, settings, sync: new WebDavSync(lib, settings) };
}
async function add(lib, file) {
  await lib.import([file]);
}
const image = path.join(__dirname, 'fixtures/ocr-text.png');
test('credentials are OS-encrypted or session-only, never exported in plaintext; changing destination does not reuse password', async (t) => {
  const root = await fixture(t),
    safe = {
      isEncryptionAvailable: () => true,
      encryptString: (s) => Buffer.from(s).reverse(),
      decryptString: (b) => Buffer.from(b).reverse().toString(),
    };
  const settings = await new DavSettings(root, safe).init();
  await settings.save({
    url: 'https://example.test/dav',
    username: 'name',
    password: 'sensitive-test-password',
  });
  const disk = await fs.readFile(settings.file, 'utf8');
  assert.ok(!disk.includes('sensitive-test-password'));
  assert.equal(settings.public().hasPassword, true);
  assert.equal((await new DavSettings(root, safe).init()).secret, 'sensitive-test-password');
  await settings.save({ url: 'https://other.test/dav/', username: 'name', password: '' });
  assert.equal(settings.secret, '');
  const fallback = await new DavSettings(path.join(root, 'fallback'), {
    isEncryptionAvailable: () => true,
    getSelectedStorageBackend: () => 'basic_text',
  }).init();
  await fallback.save({ url: 'http://localhost/dav/', username: 'x', password: 'session-only' });
  assert.ok(!(await fs.readFile(fallback.file, 'utf8')).includes('session-only'));
  assert.equal(fallback.public().passwordPersistent, false);
  assert.equal(
    (
      await new DavSettings(path.join(root, 'fallback'), {
        isEncryptionAvailable: () => false,
      }).init()
    ).secret,
    '',
  );
  assert.throws(() => normalizeUrl('https://user:password@example.test/dav'));
  assert.throws(() => normalizeUrl('file:///tmp/data'));
});
test('manual sync from an empty device downloads remote originals without erasing remote; repeat sync deduplicates', async (t) => {
  const root = await fixture(t),
    server = await davServer(t),
    a = await client(root, 'a', server.url),
    b = await client(root, 'b', server.url);
  await add(a.lib, image);
  await a.lib.update(a.lib.data.items[0].id, { favorite: true, tags: ['开心'] });
  assert.equal(server.puts, 0, 'saving config never starts network sync');
  await a.sync.run();
  assert.equal(server.puts, 1);
  await b.sync.run();
  assert.equal(b.lib.data.items.length, 1);
  assert.equal(b.lib.data.items[0].favorite, true);
  assert.deepEqual(b.lib.data.items[0].tags, ['开心']);
  await b.sync.run();
  assert.equal(b.lib.data.items.length, 1);
  assert.equal(server.probes, 0);
  const remote = path.join(root, 'remote.zip');
  await fs.writeFile(remote, server.archive);
  const staged = await stageBackup(remote);
  try {
    assert.equal(staged.manifest.items.length, 1);
  } finally {
    await staged.cleanup();
  }
  // Removing on one device is local-only; a later sync restores the remote item.
  await b.lib.remove([b.lib.data.items[0].id]);
  await b.sync.run();
  assert.equal(b.lib.data.items.length, 1);
  assert.ok(a.settings.public().lastSyncAt > 0);
});
test('empty remote backup cannot replace a populated local library and both empty does not upload', async (t) => {
  const root = await fixture(t),
    server = await davServer(t),
    a = await client(root, 'a', server.url),
    empty = await client(root, 'empty', server.url);
  await empty.sync.run();
  assert.equal(server.puts, 0);
  const file = path.join(root, 'empty.zip');
  await exportBackup(empty.lib, file);
  server.archive = await fs.readFile(file);
  await add(a.lib, image);
  await a.sync.run();
  assert.equal(a.lib.data.items.length, 1);
  const result = await client(root, 'fresh', server.url);
  await result.sync.run();
  assert.equal(result.lib.data.items.length, 1);
});
test('conflicting writes fetch and merge the new remote version before retry, preserving both images', async (t) => {
  const root = await fixture(t),
    server = await davServer(t),
    a = await client(root, 'a', server.url),
    b = await client(root, 'b', server.url);
  await add(a.lib, image);
  await a.sync.run();
  const other = path.join(root, 'other.gif');
  await fs.writeFile(
    other,
    Buffer.from(
      '47494638396101000100800000000000ffffff21f904000a0000002c00000000010001000002024401003b',
      'hex',
    ),
  );
  await add(b.lib, other);
  const backup = path.join(root, 'concurrent.zip');
  await exportBackup(b.lib, backup);
  server.conflict(await fs.readFile(backup));
  await a.sync.run();
  assert.equal(a.lib.data.items.length, 2);
  await b.sync.run();
  assert.equal(b.lib.data.items.length, 2);
});
test('missing ETag, invalid remote archives and servers ignoring conditional writes never overwrite real remote backups', async (t) => {
  const root = await fixture(t);
  for (const [name, options] of [
    ['etag', { noEtag: true }],
    ['broken', { brokenConditions: true }],
    ['corrupt', {}],
  ]) {
    const server = await davServer(t, options),
      a = await client(root, name, server.url);
    await add(a.lib, image);
    const backup = path.join(root, name + '.zip');
    await exportBackup(a.lib, backup);
    server.archive =
      name === 'corrupt' ? Buffer.from('<html>login</html>') : await fs.readFile(backup);
    const previous = server.archive;
    await assert.rejects(
      a.sync.run(),
      name === 'etag' ? /ETag/ : name === 'broken' ? /条件写入/ : /备份/,
    );
    assert.deepEqual(server.archive, previous);
    assert.equal(server.puts, 0);
    assert.equal(a.settings.public().lastSyncAt, 0);
    assert.equal(server.probes, 0);
  }
});
test('two simultaneous first-sync clients preserve both libraries with conditional-create retry', async (t) => {
  const root = await fixture(t),
    server = await davServer(t),
    a = await client(root, 'a', server.url),
    b = await client(root, 'b', server.url);
  await add(a.lib, image);
  const other = path.join(root, 'different.gif');
  await fs.writeFile(
    other,
    Buffer.from(
      '47494638396101000100800000000000ffffff21f904000a0000002c00000000010001000002024401003b',
      'hex',
    ),
  );
  await add(b.lib, other);
  await Promise.all([a.sync.run(), b.sync.run()]);
  await a.sync.run();
  await b.sync.run();
  assert.equal(a.lib.data.items.length, 2);
  assert.equal(b.lib.data.items.length, 2);
  assert.equal(server.probes, 0);
});
test('cancellation stops requests without uploading or marking a successful sync', async (t) => {
  const root = await fixture(t),
    server = await davServer(t),
    a = await client(root, 'cancel', server.url);
  await add(a.lib, image);
  const pending = a.sync.run();
  a.sync.cancel();
  await assert.rejects(pending, /取消/);
  assert.equal(server.puts, 0);
  assert.equal(a.settings.public().lastSyncAt, 0);
  assert.equal(a.lib.data.items.length, 1);
});
