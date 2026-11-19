const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { discoverQQPaths } = require('../src/qq-paths.cjs');
const { connectorDefaultDirectory } = require('../src/wechat-paths.cjs');
async function fixture(fn) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'qq-path-test-'));
  try {
    await fn(home);
  } finally {
    await fs.rm(home, { recursive: true, force: true });
  }
}
test('Windows QQ uses redirected Documents and numeric account NT layout', () =>
  fixture(async (home) => {
    const documents = path.join(home, 'OneDrive/文档'),
      root = path.join(documents, 'Tencent Files'),
      ori = path.join(root, '123456/nt_qq/nt_data/Emoji/personal_emoji/Ori');
    await fs.mkdir(ori, { recursive: true });
    assert.deepEqual(await discoverQQPaths({ home, documents, platform: 'win32' }), [ori]);
    assert.equal(
      await connectorDefaultDirectory('qq', { home, documents, platform: 'win32' }),
      ori,
    );
  }));
test('QQ accepts account, data, emoji and direct original directory selections', () =>
  fixture(async (home) => {
    const root = path.join(home, 'DiskD/QQ数据'),
      account = path.join(root, '123456'),
      ori = path.join(account, 'nt_qq/nt_data/Emoji/personal_emoji/Ori');
    await fs.mkdir(ori, { recursive: true });
    for (const override of [
      root,
      account,
      path.join(account, 'nt_qq'),
      path.join(account, 'nt_qq/nt_data'),
      path.join(account, 'nt_qq/nt_data/Emoji'),
      path.join(ori, '..'),
      ori,
    ])
      assert.deepEqual(await discoverQQPaths({ home, platform: 'win32', override }), [ori]);
  }));
test('Windows QQ finds AppData NT accounts and excludes thumbnails or global bundled resources', () =>
  fixture(async (home) => {
    const appData = path.join(home, 'Roaming'),
      base = path.join(appData, 'Tencent/QQ'),
      ori = path.join(base, 'nt_qq_hash/nt_data/Emoji/personal_emoji/Ori');
    await fs.mkdir(ori, { recursive: true });
    await fs.mkdir(path.join(base, 'global/nt_data/Emoji/emoji-resource/Ori'), { recursive: true });
    await fs.mkdir(path.join(base, 'nt_qq_other/nt_data/Emoji/personal_emoji/Thumb'), {
      recursive: true,
    });
    assert.deepEqual(await discoverQQPaths({ home, appData, platform: 'win32' }), [ori]);
  }));
test('Windows QQ reads explicitly configured custom data parent', () =>
  fixture(async (home) => {
    const appData = path.join(home, 'Roaming'),
      custom = path.join(home, 'DiskD/Tencent Files'),
      ori = path.join(custom, '123456/nt_qq/nt_data/Emoji/personal_emoji/Ori');
    await fs.mkdir(ori, { recursive: true });
    const misc = path.join(appData, 'Tencent/QQ/Misc');
    await fs.mkdir(misc, { recursive: true });
    await fs.writeFile(
      path.join(misc, 'UserDataInfo.ini'),
      '[UserDataSet]\r\nUserDataSavePath=' + custom + '\r\n',
    );
    assert.deepEqual(await discoverQQPaths({ home, appData, platform: 'win32' }), [ori]);
  }));
