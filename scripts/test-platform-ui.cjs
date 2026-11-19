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
    assert.equal(await js('document.querySelector("#ocr-enabled").checked'), true);
    await js('document.querySelector("#ocr-enabled").onchange({target:{checked:false}})');
    assert.equal(await js('state.ocr.enabled'), false);
    await js('document.querySelector("#startup-enabled").onchange({target:{checked:true}})');
    assert.equal(await js('state.startup.requested'), true);
    await js('document.querySelector("#startup-enabled").onchange({target:{checked:false}})');
    assert.equal(await js('state.startup.requested'), false);
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
    await win.loadFile(path.join(__dirname, '../src/panel.html'));
    await js(
      `window.vault.state().then(s=>{state=s;state.items=Array.from({length:301},(_,i)=>({id:String(i),name:"表情"+i,tags:[],createdAt:301-i,url:"data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7"}));document.querySelector('[data-filter="all"]').click()})`,
    );
    assert.ok((await js('document.querySelector("#count").textContent')).includes('共 301 个'));
    await js('while(shown<matchingItems.length) appendPage()');
    assert.equal(await js('document.querySelectorAll(".item").length'), 301);
    assert.equal(await js('document.querySelector("#load-more")'), null);
    await js('document.querySelector("#search").value="表情300";render()');
    assert.equal(await js('document.querySelectorAll(".item").length'), 1);
    assert.equal(await js('document.querySelector(".item").title'), '表情300');
    console.log(
      'PREFERENCES_PANEL_PASS: switches work, all 301 stickers reachable and searchable beyond first page',
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
