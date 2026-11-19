const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const {
  discoverWechat,
  connectorDefaultDirectory,
  helperName,
  wechatCacheDirectory,
} = require('../src/wechat-paths.cjs');
const { Connectors } = require('../src/connectors.cjs');
const { Library } = require('../src/library.cjs');
async function account(root, name) {
  const db = path.join(root, name, 'db_storage/emoticon');
  await fs.mkdir(db, { recursive: true });
  await fs.writeFile(path.join(db, 'emoticon.db'), 'fixture');
}
async function fixture(fn) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'wechat-path-test-'));
  try {
    await fn(home);
  } finally {
    await fs.rm(home, { recursive: true, force: true });
  }
}
test('Windows defaults find profile xwechat_files and non-wxid account names; ignore shared folders', () =>
  fixture(async (home) => {
    const root = path.join(home, 'xwechat_files');
    await account(root, 'custom_name_123');
    await fs.mkdir(path.join(root, 'all_users'), { recursive: true });
    const d = await discoverWechat({ home, platform: 'win32' });
    assert.equal(d.accounts.length, 1);
    assert.equal(d.accounts[0].id, 'custom_name_123');
    assert.equal(d.accounts[0].root, root);
    assert.equal(await connectorDefaultDirectory('wechat', { home, platform: 'win32' }), root);
  }));
test('Windows uses redirected Documents and supports selecting account or its parent', () =>
  fixture(async (home) => {
    const documents = path.join(home, 'OneDrive-custom/文档'),
      root = path.join(documents, 'xwechat_files');
    await account(root, 'wxid_example');
    for (const override of [undefined, root, path.join(root, 'wxid_example'), documents]) {
      const d = await discoverWechat({ home, documents, platform: 'win32', override });
      assert.equal(d.accounts[0].root, root);
    }
    assert.equal(
      await connectorDefaultDirectory('wechat', { home, documents, platform: 'win32' }),
      root,
    );
  }));
test('Windows reads custom data parent from config and keeps explicit selection strict', () =>
  fixture(async (home) => {
    const appData = path.join(home, 'Roaming'),
      custom = path.join(home, 'DiskD/微信数据'),
      root = path.join(custom, 'xwechat_files');
    await account(root, 'custom_account');
    const conf = path.join(appData, 'Tencent/Weixin/All Users/config');
    await fs.mkdir(conf, { recursive: true });
    await fs.writeFile(path.join(conf, '3ebffe94.ini'), '\ufeff' + custom + '\r\n', 'utf16le');
    assert.equal(
      (await discoverWechat({ home, appData, platform: 'win32' })).accounts[0].root,
      root,
    );
    assert.equal(
      (
        await discoverWechat({
          home,
          appData,
          platform: 'win32',
          override: path.join(home, 'wrong'),
        })
      ).accounts.length,
      0,
    );
  }));
test('Windows empty directory chooser starts at real Documents, never a macOS container', () =>
  fixture(async (home) => {
    const documents = path.join(home, 'redirected-documents');
    await fs.mkdir(documents);
    const selected = await connectorDefaultDirectory('wechat', {
      home,
      documents,
      platform: 'win32',
    });
    assert.equal(selected, documents);
    assert.ok(!selected.includes('Library/Containers'));
    assert.equal(helperName('win32'), 'wxemoticon.exe');
    assert.equal(
      wechatCacheDirectory({ home, platform: 'win32', localAppData: path.join(home, 'Local') }),
      path.join(home, 'Local/wxemoticon'),
    );
  }));
test('macOS account root remains compatible', () =>
  fixture(async (home) => {
    const root = path.join(
      home,
      'Library/Containers/com.tencent.xinWeChat/Data/Documents/xwechat_files',
    );
    await account(root, 'wxid_mac');
    assert.equal((await discoverWechat({ home, platform: 'darwin' })).accounts[0].root, root);
  }));
test('Windows adapter invokes exe with normalized root and Windows process options', () =>
  fixture(async (home) => {
    const root = path.join(home, 'custom/xwechat_files');
    await account(root, 'custom_user');
    const helper = path.join(home, 'wxemoticon.exe');
    await fs.writeFile(helper, 'fake executable for spawn stub');
    const lib = await new Library(path.join(home, 'vault')).init();
    lib.data.connectors = { wechat: { base: path.join(root, 'custom_user') } };
    let call;
    let resolveDone;
    const done = new Promise((r) => (resolveDone = r));
    const fakeSpawn = (file, args, options) => {
      call = { file, args, options };
      const c = new EventEmitter();
      c.stdout = new EventEmitter();
      c.stderr = new EventEmitter();
      setImmediate(() => {
        c.stdout.emit('data', Buffer.from('{"failed":0}'));
        c.emit('close', 0);
      });
      return c;
    };
    const c = new Connectors(
      lib,
      () => {
        if (lib.data.connectors.wechat?.status === 'ready') resolveDone();
      },
      home,
      'win32',
      { helperPath: helper, spawn: fakeSpawn },
    );
    await c.wechat();
    await Promise.race([
      done,
      new Promise((_, reject) => {
        const timer = setTimeout(() => reject(Error('adapter timeout')), 3000);
        timer.unref();
      }),
    ]);
    assert.equal(call.file, helper);
    assert.equal(call.args[call.args.indexOf('--wechat-data-dir') + 1], root);
    assert.equal(call.options.windowsHide, true);
    assert.equal(lib.data.connectors.wechat.initialized, true);
    assert.equal(lib.data.connectors.wechat.dataRoot, root);
    assert.ok(!lib.data.connectors.wechat.message.includes('macOS'));
  }));
