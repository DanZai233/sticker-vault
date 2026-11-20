// Real Electron window + local protocol fixture. No account, network login or user profile.
const { app, session } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'sticker-douyin-test-'));
app.setPath('userData', profile);
app.disableHardwareAcceleration();
app.on('window-all-closed', () => {});
let connector;
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const watchdog = setTimeout(() => {
  console.error('Douyin fixture timed out');
  app.exit(1);
}, 20000);
app.whenReady().then(async () => {
  console.log('fixture: ready');
  try {
    const ses = session.fromPartition('persist:douyin-stickers');
    const payload = { status_code: 0, custom_sticker_page_list: { resources: [] } };
    await ses.protocol.handle('https', (request) => {
      if (request.url.includes('/aggregation'))
        return new Response(JSON.stringify(payload), {
          headers: { 'content-type': 'application/json' },
        });
      return new Response(
        '<!doctype html><title>Official page fixture</title><body>Local fixture</body>',
        { headers: { 'content-type': 'text/html' } },
      );
    });
    const c = {
      lib: { data: { connectors: { douyin: {} } } },
      status(id, s) {
        Object.assign(this.lib.data.connectors[id], s);
      },
      async persist() {},
    };
    const { DouyinConnector } = require('../src/douyin.cjs');
    connector = new DouyinConnector(c);
    const received = [];
    connector.consume = async (data) => received.push(data);
    console.log('fixture: opening');
    await connector.open();
    console.log('fixture: opened');
    connector.win.hide();
    const wc = connector.view.webContents;
    const deadline = Date.now() + 10000;
    while (wc.isLoading() || wc.getURL() === '') {
      if (Date.now() > deadline) throw Error('fixture load timed out');
      await delay(50);
    }
    console.log('fixture: loaded');
    const isolation = await wc.executeJavaScript(
      `({fetchNative: Function.prototype.toString.call(fetch).includes('[native code]'), xhrNative: Function.prototype.toString.call(XMLHttpRequest.prototype.open).includes('[native code]'), vault: typeof window.vault, toolbar: typeof window.douyinWindow})`,
    );
    assert.deepEqual(isolation, {
      fetchNative: true,
      xhrNative: true,
      vault: 'undefined',
      toolbar: 'undefined',
    });
    await wc.executeJavaScript(
      `fetch('/aweme/v1/web/im/resource/list/aggregation/?scenes=CUSTOM_STICKER_PAGE').then(r=>r.json())`,
    );
    while (!received.length) {
      if (Date.now() > deadline) throw Error('collection response not observed');
      await delay(50);
    }
    assert.deepEqual(received, [payload]);
    await wc.executeJavaScript(`fetch('/passport/login/').then(r=>r.text())`);
    await delay(100);
    assert.equal(received.length, 1);
    const shellState = await connector.win.webContents.executeJavaScript(
      `({buttons: document.querySelectorAll('button').length, vault: typeof window.vault, toolbar: typeof window.douyinWindow})`,
    );
    assert.deepEqual(shellState, { buttons: 4, vault: 'undefined', toolbar: 'object' });
    connector.close();
    await delay(100);
    assert.ok(wc.isDestroyed());
    clearTimeout(watchdog);
    console.log(
      'DOUYIN_WINDOW_PASS: native fetch/XHR, isolated toolbar, passive collection, no login-body capture, close cleanup',
    );
    app.exit(0);
  } catch (error) {
    console.error(error);
    if (connector) connector.close();
    app.exit(1);
  }
});
app.on('quit', () => {
  try {
    fs.rmSync(profile, { recursive: true, force: true });
  } catch {}
});
