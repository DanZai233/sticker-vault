const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const assert = require('node:assert/strict');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'sticker-ui-test-'));
app.setPath('userData', profile);
app.disableHardwareAcceleration();
// This isolated CI window loads local fixtures only, never account data.
if (process.env.CI && process.platform === 'linux') app.commandLine.appendSwitch('no-sandbox');
app.whenReady().then(async () => {
  try {
    const win = new BrowserWindow({
      show: false,
      webPreferences: {
        preload: path.join(__dirname, '../test/platform-ui-preload.cjs'),
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
      },
    });
    await win.loadFile(path.join(__dirname, '../src/index.html'));
    const js = (code) => win.webContents.executeJavaScript(code);
    await js(
      'window.vault.state().then(s=>{state=s;render();document.querySelector("#manage").click()})',
    );
    assert.equal(await js('document.querySelector(".paste-access").hidden'), true);
    const windowsText = await js('document.querySelector("#connector-list").textContent');
    assert.ok(windowsText.includes('选择数据目录'));
    assert.ok(!windowsText.includes('微信副本'));
    assert.ok(!windowsText.includes('授权助手缓存'));
    await js('state.platform="darwin";render()');
    assert.equal(await js('document.querySelector(".paste-access").hidden'), false);
    assert.ok(
      (await js('document.querySelector("#connector-list").textContent')).includes('授权助手缓存'),
    );
    await js('state.platform="linux";render()');
    assert.equal(await js('document.querySelector(".paste-access").hidden'), true);
    console.log(
      'PLATFORM_UI_PASS: Windows hides macOS controls, macOS retains controls, Linux hides controls',
    );
    win.destroy();
    app.exit(0);
  } catch (e) {
    console.error(e);
    app.exit(1);
  }
});
app.on('will-quit', () => {
  try {
    fs.rmSync(profile, { recursive: true, force: true });
  } catch {}
});
