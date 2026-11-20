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
    if (process.env.CI && process.platform === 'win32') {
      const { StartupControl } = require('../src/startup.cjs');
      app.setAppUserModelId('com.stickervault.ci.startup.' + process.pid);
      const startup = new StartupControl({
        app: {
          isPackaged: true,
          getLoginItemSettings: (opts) => app.getLoginItemSettings(opts),
          setLoginItemSettings: (opts) => app.setLoginItemSettings(opts),
        },
      });
      try {
        const enabled = await startup.set(true);
        assert.equal(enabled.requested, true);
        assert.equal(enabled.enabled, true);
      } finally {
        await startup.set(false);
      }
      assert.equal((await startup.get()).requested, false);
      console.log('WINDOWS_STARTUP_PASS: real registry registration, status and removal');
    }
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
    assert.equal(
      await js('window.vault.operations().then(ops=>ops.filter(op=>op.type==="dav-sync").length)'),
      0,
    );
    await js(
      'document.querySelector("#dav-url").value="https://example.test/manual/";document.querySelector("#dav-username").value="name";document.querySelector("#dav-password").value="test-secret";document.querySelector("#dav-save").onclick()',
    );
    assert.equal(await js('document.querySelector("#dav-password").value'), '');
    assert.equal(
      await js('window.vault.operations().then(ops=>ops.filter(op=>op.type==="dav-sync").length)'),
      0,
    );
    await js('document.querySelector("#dav-sync").onclick()');
    assert.equal(
      await js('window.vault.operations().then(ops=>ops.filter(op=>op.type==="dav-sync").length)'),
      1,
    );
    await js('document.querySelector("#backup-export").onclick()');
    await js('document.querySelector("#backup-import").onclick()');
    assert.equal(
      await js(
        'window.vault.operations().then(ops=>ops.filter(op=>op.type==="backup-import").length)',
      ),
      1,
    );
    await js(
      'state.transferState.transfer={busy:true,kind:"sync",phase:"uploading",bytes:100,byteTotal:200};renderTransferSettings()',
    );
    assert.equal(await js('document.querySelector("#dav-sync").disabled'), true);
    assert.equal(await js('document.querySelector("#transfer-cancel").hidden'), false);
    await js('state.transferState.transfer={busy:false};renderTransferSettings()');
    console.log(
      'TRANSFER_UI_PASS: export/import controls, explicit manual sync only, password cleared, progress and cancellation',
    );
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
    await js('document.querySelectorAll("dialog[open]").forEach(dialog=>dialog.close())');
    await js(
      `window.vault.fixtureItems(Array.from({length:3},(_,i)=>({id:String(i),name:'表情'+i,tags:[],source:'测试',size:100,ext:'gif',createdAt:3-i,lastUsedAt:3-i,url:'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'})))`,
    );
    const click = (selector) =>
      js(
        'new Promise(resolve=>{document.querySelector(' +
          JSON.stringify(selector) +
          ').click();setTimeout(resolve,50)})',
      );
    assert.equal(await js('document.querySelectorAll("#grid button button").length'), 0);
    await click('.card[data-id="2"] .quick-favorite');
    assert.equal(
      await js(
        `document.querySelector('.card[data-id="2"] .quick-favorite').getAttribute("aria-pressed")`,
      ),
      'true',
    );
    await click('.card[data-id="2"] .quick-favorite');
    assert.equal(
      await js(
        `document.querySelector('.card[data-id="2"] .quick-favorite').getAttribute("aria-pressed")`,
      ),
      'false',
    );
    await click('.card[data-id="2"] .quick-front');
    assert.equal(await js('document.querySelector(".card").dataset.id'), '2');
    await click('.card[data-id="2"] .quick-front');
    assert.equal(await js('document.querySelector(".card").dataset.id'), '2');
    await click('.card[data-id="1"] .quick-front');
    assert.equal(await js('document.querySelector(".card").dataset.id'), '1');
    assert.equal(
      await js('document.querySelector(".quick-front").hasAttribute("aria-pressed")'),
      false,
    );
    assert.equal(
      await js(
        'window.vault.operations().then(ops=>ops.filter(op=>op.type==="copy"||op.type==="insert").length)',
      ),
      0,
    );
    console.log('MAIN_ACTIONS_PASS: favorite toggle, repeatable move-to-front, no accidental copy');
    await js(
      `window.vault.fixtureItems(Array.from({length:5000},(_,i)=>({id:String(i),name:'表情'+i,tags:[],source:'测试',size:100,ext:'gif',createdAt:5000-i,lastUsedAt:5000-i,animated:true,url:'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'})))`,
    );
    assert.ok(await js('document.querySelectorAll(".card").length < 100'));
    await js(
      'mainGrid.reveal(3000);window.stableImage=mainGrid.nodes.get("3000").querySelector("img");window.stableScroll=scrollY',
    );
    await js('window.vault.update("3000",{favorite:true})');
    assert.equal(
      await js('mainGrid.nodes.get("3000").querySelector("img")===window.stableImage'),
      true,
    );
    assert.equal(await js('scrollY===window.stableScroll'), true);
    await js('mainGrid.reveal(4999)');
    assert.ok(await js('!!mainGrid.nodes.get("4999")'));
    assert.ok(await js('document.querySelectorAll(".card").length < 100'));
    assert.equal(await js('window.stableImage.getAttribute("src")'), null);
    await js('window.scrollTo(0,0);mainGrid.draw()');
    console.log(
      'VIRTUAL_GRID_PASS: 5000 items, bounded DOM, last item reachable, stable image and scroll after favorite, offscreen source released',
    );
    await js('window.vault.remove(["0"])');
    await js(`document.querySelector('[data-filter="trash"]').click()`);
    assert.equal(await js('document.querySelectorAll(".card").length'), 1);
    await js(`document.querySelector('.card[data-id="0"] .card-actions button').click()`);
    await js('new Promise(resolve=>setTimeout(resolve,50))');
    assert.equal(await js('state.trash.length'), 0);
    await js(`document.querySelector('[data-filter="all"]').click()`);
    await js('window.vault.fixtureReport()');
    await js('openReport("fixture-report")');
    assert.ok(
      (await js('document.querySelector("#report-summary").textContent')).includes('失败 1'),
    );
    await js('document.querySelector("#report-filter").value="failed";renderReportDetails()');
    assert.equal(await js('reportGrid.items.length'), 1);
    await js('document.querySelector("#report-retry").onclick()');
    assert.equal(
      await js(
        'window.vault.operations().then(ops=>ops.filter(op=>op.type==="retry-import").length)',
      ),
      1,
    );
    await js('document.querySelector("#diagnostics-dialog").close()');
    console.log('TRASH_DIAGNOSTICS_UI_PASS: bin restore and failure filter/retry');
    await win.loadFile(path.join(__dirname, '../src/panel.html'));
    await js(
      `window.vault.fixtureItems(Array.from({length:301},(_,i)=>({id:String(i),name:"表情"+i,tags:[],createdAt:301-i,url:"data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7"}))).then(()=>document.querySelector('[data-filter="all"]').click())`,
    );
    assert.ok((await js('document.querySelector("#count").textContent')).includes('共 301 个'));
    assert.ok(await js('document.querySelectorAll(".item").length < 80'));
    await js('panelGrid.reveal(300)');
    assert.equal(await js(`document.querySelector('.item[data-id="300"]').title`), '表情300');
    await js('document.querySelector("#search").value="表情300";render()');
    assert.equal(await js('document.querySelectorAll(".item").length'), 1);
    assert.equal(await js('document.querySelector(".item").title'), '表情300');
    console.log(
      'PREFERENCES_PANEL_PASS: switches work, all 301 stickers reachable and searchable beyond first page',
    );
    await js('document.querySelector("#search").value="";render()');
    assert.equal(
      await js('getComputedStyle(document.querySelector(".item .card-actions")).pointerEvents'),
      'none',
    );
    await js('document.querySelector(".item .quick-favorite").focus()');
    assert.equal(
      await js('getComputedStyle(document.querySelector(".item .card-actions")).pointerEvents'),
      'auto',
    );
    await click('.item[data-id="1"] .quick-favorite');
    assert.equal(
      await js(
        `document.querySelector('.item[data-id="1"] .quick-favorite').getAttribute("aria-pressed")`,
      ),
      'true',
    );
    await click('.item[data-id="1"] .quick-front');
    assert.equal(await js('document.querySelector(".item").dataset.id'), '1');
    await click('.item[data-id="1"] .quick-front');
    assert.equal(await js('document.querySelector(".item").dataset.id'), '1');
    assert.equal(await js('document.querySelectorAll(".item button button").length'), 0);
    assert.equal(
      await js(
        'window.vault.operations().then(ops=>ops.filter(op=>op.type==="copy"||op.type==="insert").length)',
      ),
      0,
    );
    console.log('PANEL_ACTIONS_PASS: favorite and repeated move-to-front do not insert or copy');
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
