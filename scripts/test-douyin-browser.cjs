// Dedicated, disposable headless browser. Fixtures only; never touch personal profiles.
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { browserCandidates, openBrowserCollector } = require('../src/douyin-browser.cjs');
(async () => {
  let executable;
  for (const p of browserCandidates()) {
    try {
      await fs.access(p);
      executable = p;
      break;
    } catch {}
  }
  if (!executable) {
    console.log('DOUYIN_BROWSER_SKIP: no supported browser on this runner');
    return;
  }
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'sticker-browser-fixture-'));
  let collector;
  try {
    const seen = [],
      errors = [];
    collector = await openBrowserCollector({
      profile,
      executable,
      extraArgs: ['--headless=new'],
      initialURL: 'about:blank',
      onCollection: (data) => seen.push(data),
      onError: () => errors.push(true),
    });
    const debug = collector.debug;
    const fixture = { status_code: 0, custom_sticker_page_list: { resources: [] } };
    debug.on('message', (_, method, p) => {
      if (method === 'Fetch.requestPaused')
        debug
          .sendCommand('Fetch.fulfillRequest', {
            requestId: p.requestId,
            responseCode: 200,
            responseHeaders: [
              {
                name: 'Content-Type',
                value: p.request.url.includes('/aggregation') ? 'application/json' : 'text/html',
              },
              { name: 'Access-Control-Allow-Origin', value: '*' },
            ],
            body: Buffer.from(
              p.request.url.includes('/aggregation')
                ? JSON.stringify(fixture)
                : '<!doctype html><title>Offline browser fixture</title><body>Fixture</body>',
            ).toString('base64'),
          })
          .catch(() => {});
    });
    await debug.sendCommand('Fetch.enable', {
      patterns: [{ urlPattern: 'https://www.douyin.com/*', requestStage: 'Request' }],
    });
    const loaded = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Error('fixture navigation timeout')), 10000);
      const listener = (_, method) => {
        if (method === 'Page.loadEventFired') {
          clearTimeout(timer);
          debug.removeListener('message', listener);
          resolve();
        }
      };
      debug.on('message', listener);
    });
    await debug.sendCommand('Page.navigate', { url: 'https://www.douyin.com/' });
    await loaded;
    const native = await debug.sendCommand('Runtime.evaluate', {
      expression: `Function.prototype.toString.call(fetch).includes('[native code]')`,
    });
    assert.equal(native.result.value, true);
    const fetched = await debug.sendCommand('Runtime.evaluate', {
      expression: `fetch('https://www.douyin.com/aweme/v1/web/im/resource/list/aggregation/?scenes=CUSTOM_STICKER_PAGE').then(r=>r.json())`,
      awaitPromise: true,
    });
    assert.equal(fetched.exceptionDetails, undefined, 'offline collection request succeeds');
    for (let i = 0; i < 100 && !seen.length; i++) await new Promise((r) => setTimeout(r, 50));
    assert.deepEqual(seen, [fixture]);
    assert.deepEqual(errors, []);
    let disconnected = false;
    debug.once('detach', () => {
      disconnected = true;
    });
    await debug.sendCommand('Page.close').catch(() => {});
    for (let i = 0; i < 100 && !disconnected; i++) await new Promise((r) => setTimeout(r, 50));
    assert.ok(disconnected, 'closing page disconnects collection');
    await collector.close();
    collector = await openBrowserCollector({
      profile,
      executable,
      extraArgs: ['--headless=new'],
      initialURL: 'about:blank',
      onCollection: () => {},
      onError: () => {},
    });
    await collector.focus();
    await collector.close();
    console.log(
      'DOUYIN_BROWSER_PASS: real dedicated Chromium profile, native fetch, captured fixture, cleanup',
    );
  } finally {
    collector?.close();
    await new Promise((r) => setTimeout(r, 300));
    await fs.rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
