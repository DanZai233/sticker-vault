const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { StartupControl, quoteDesktopArgument } = require('../src/startup.cjs');
function fakeApp() {
  let state = { openAtLogin: false, executableWillLaunchAtLogin: false, status: 'not-registered' };
  const calls = [];
  return {
    isPackaged: true,
    calls,
    getLoginItemSettings: (opts) => {
      calls.push({ read: opts });
      return state;
    },
    setLoginItemSettings: (opts) => {
      calls.push({ write: opts });
      state = {
        openAtLogin: opts.openAtLogin,
        executableWillLaunchAtLogin: opts.enabled ?? opts.openAtLogin,
        status: opts.openAtLogin ? 'enabled' : 'not-registered',
      };
    },
    setState: (value) => (state = value),
  };
}
test('Windows startup uses current-user Electron login settings with the exact executable and background argument', async () => {
  const app = fakeApp(),
    exe = 'C:\\Program Files\\StickerVault\\StickerVault.exe';
  const c = new StartupControl({ app, platform: 'win32', execPath: exe, env: {} });
  assert.equal((await c.get()).enabled, false);
  assert.equal((await c.set(true)).enabled, true);
  const write = app.calls.find((c) => c.write).write;
  assert.deepEqual(write, {
    openAtLogin: true,
    enabled: true,
    path: exe,
    args: ['--background'],
  });
  assert.equal((await c.set(false)).enabled, false);
});
test('macOS startup uses system login items and exposes required approval rather than claiming success', async () => {
  const app = fakeApp(),
    c = new StartupControl({ app, platform: 'darwin', env: {} });
  await c.set(true);
  assert.deepEqual(app.calls.find((c) => c.write).write, { openAtLogin: true });
  app.setState({ openAtLogin: false, status: 'requires-approval' });
  const s = await c.get();
  assert.equal(s.enabled, false);
  assert.equal(s.requested, true);
  assert.equal(s.requiresApproval, true);
});
test('development builds never register a login item', async () => {
  const app = fakeApp();
  app.isPackaged = false;
  const c = new StartupControl({ app, platform: 'win32', env: {} });
  assert.equal((await c.get()).supported, false);
  await assert.rejects(c.set(true), /开发模式/);
  assert.equal(app.calls.length, 0);
});
test('Linux startup writes only owned XDG desktop file, quotes paths safely, detects moved AppImages and removes on disable', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'sticker-startup-'));
  try {
    const app = fakeApp(),
      image = path.join(home, '表情 $100% "test".AppImage'),
      env = { APPIMAGE: image, XDG_CONFIG_HOME: path.join(home, 'custom-config') };
    const c = new StartupControl({
      app,
      platform: 'linux',
      home,
      env,
      execPath: '/tmp/.mount/wrong',
    });
    assert.equal((await c.get()).enabled, false);
    await c.set(true);
    const text = await fs.readFile(c.file, 'utf8');
    assert.ok(text.includes('Exec=' + quoteDesktopArgument(image) + ' --background'));
    assert.ok(text.includes('%%'));
    assert.equal((await c.get()).enabled, true);
    const moved = new StartupControl({
      app,
      platform: 'linux',
      home,
      env: { ...env, APPIMAGE: path.join(home, 'new.AppImage') },
    });
    assert.equal((await moved.get()).needsUpdate, true);
    await moved.set(true);
    assert.equal((await moved.get()).enabled, true);
    await moved.set(false);
    assert.equal((await moved.get()).enabled, false);
    assert.equal(app.calls.length, 0);
    assert.throws(() => quoteDesktopArgument('/tmp/bad\nfile'), /无效/);
  } finally {
    await fs.rm(home, { recursive: true, force: true });
  }
});
test('Linux preserves an unrelated existing autostart file', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'sticker-startup-'));
  try {
    const c = new StartupControl({
      app: fakeApp(),
      platform: 'linux',
      home,
      env: {},
      execPath: '/opt/StickerVault',
    });
    await fs.mkdir(path.dirname(c.file), { recursive: true });
    const text = '[Desktop Entry]\nExec=/other/tool\n';
    await fs.writeFile(c.file, text);
    assert.equal((await c.get()).supported, false);
    await assert.rejects(c.set(false), /其他工具/);
    assert.equal(await fs.readFile(c.file, 'utf8'), text);
  } finally {
    await fs.rm(home, { recursive: true, force: true });
  }
});
