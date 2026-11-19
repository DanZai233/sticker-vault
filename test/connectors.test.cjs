const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { Library } = require('../src/library.cjs');
const { Connectors, discoverQQ, collectedStickers, allowedCDN } = require('../src/connectors.cjs');
test('QQ locates only personal originals, reads mislabeled GIF, increments and persists cursor', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'qq-adapter-'));
  try {
    const base = path.join(
      home,
      'Library/Containers/com.tencent.qq/Data/Library/Application Support/QQ/nt_qq_abc/nt_data/Emoji/personal_emoji',
    );
    await fs.mkdir(path.join(base, 'Ori'), { recursive: true });
    await fs.mkdir(path.join(base, 'Thumb'), { recursive: true });
    const gif = Buffer.concat([
      Buffer.from('47494638396101000100800000000000ffffff', 'hex'),
      ...Array(2).fill(Buffer.from('21f904000a0000002c0000000001000100000202440100', 'hex')),
      Buffer.from([59]),
    ]);
    await fs.writeFile(path.join(base, 'Ori', 'animation.jpg'), gif);
    await fs.writeFile(path.join(base, 'Thumb', 'preview.png'), Buffer.from('not original'));
    assert.deepEqual(await discoverQQ(home, 'darwin'), [path.join(base, 'Ori')]);
    const lib = await new Library(path.join(home, 'vault')).init();
    const c = new Connectors(lib, () => {}, home, 'darwin');
    await c.qq();
    assert.equal(lib.data.items.length, 1);
    const i = lib.data.items[0];
    assert.equal(i.ext, 'gif');
    assert.equal(i.animated, true);
    assert.equal(i.source, 'QQ');
    assert.deepEqual(await fs.readFile(path.join(lib.root, 'originals', i.file)), gif);
    await lib.remove([i.id]);
    await c.qq();
    assert.equal(lib.data.items.length, 0, 'manually removed automatic item stays removed');
    const reload = await new Library(lib.root).init();
    assert.ok(reload.data.connectors.qq.enabled);
    assert.equal(Object.keys(reload.data.autoSeen.qq).length, 1);
    await fs.writeFile(path.join(base, 'Ori', 'new.jpg'), Buffer.concat([gif, Buffer.from([0])]));
    await c.qq();
    assert.equal(lib.data.items.length, 1);
  } finally {
    await fs.rm(home, { recursive: true, force: true });
  }
});
test('Douyin reads only custom collection, prioritizes animation, never substitutes static for missing animation', () => {
  const r = collectedStickers({
    status_code: 0,
    custom_sticker_page_list: {
      resources: [
        {
          stickers: [
            {
              id_str: '1',
              animate_url: {
                url_list: ['https://a.douyinpic.com/a.gif', 'https://a.douyinpic.com/origin.gif'],
              },
              static_url: { url_list: ['https://a.douyinpic.com/preview.png'] },
            },
            { id_str: '2', static_url: { url_list: ['https://a.douyinpic.com/b.png'] } },
            {
              id_str: '3',
              animate_url: { url_list: [] },
              static_url: { url_list: ['https://a.douyinpic.com/preview.png'] },
            },
          ],
        },
      ],
      has_more: true,
      next_cursor: 100,
    },
  });
  assert.equal(r.items.length, 2);
  assert.equal(r.items[0].url, 'https://a.douyinpic.com/origin.gif');
  assert.equal(r.items[0].animated, true);
  assert.equal(r.items[1].animated, false);
  assert.equal(r.hasMore, true);
  assert.throws(() => collectedStickers({ status_code: 0, resources: [] }));
  assert.throws(() => collectedStickers({ status_code: 8, custom_sticker_page_list: {} }));
});
test('remote image allowlist rejects local URLs and lookalike hosts', () => {
  assert.ok(allowedCDN('https://p1.douyinpic.com/x'));
  for (const u of [
    'http://p1.douyinpic.com/a',
    'https://douyinpic.com.evil.test/a',
    'https://127.0.0.1/a',
    'file:///etc/passwd',
    'https://user:pass@p1.douyinpic.com/a',
    'https://p1.douyinpic.com:9999/a',
  ])
    assert.equal(allowedCDN(u), false);
});
