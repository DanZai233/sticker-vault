const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const {
  collectionURL,
  trustedNavigation,
  observeCollections,
} = require('../src/douyin-network.cjs');
const url =
  'https://www.douyin.com/aweme/v1/web/im/resource/list/aggregation/?scenes=CUSTOM_STICKER_PAGE';
const tick = () => new Promise((resolve) => setImmediate(resolve));
test('Douyin navigation permits only HTTPS Douyin pages, collection filter is exact', () => {
  for (const raw of ['https://www.douyin.com/', 'https://sso.douyin.com/login'])
    assert.ok(trustedNavigation(raw));
  for (const raw of [
    'http://www.douyin.com/',
    'https://douyin.com.evil.test/',
    'https://user@www.douyin.com/',
    'https://www.douyin.com:444/',
    'javascript:alert(1)',
  ])
    assert.equal(trustedNavigation(raw), false);
  assert.ok(collectionURL(url));
  for (const raw of [
    url.replace('CUSTOM_STICKER_PAGE', 'OTHER'),
    url.replace('www.', 'login.'),
    'https://www.douyin.com/passport/login/',
    url.replace('https:', 'http:'),
  ])
    assert.equal(collectionURL(raw), false);
});
function fixture(body) {
  const wc = new EventEmitter();
  const debug = (wc.debugger = new EventEmitter());
  let attached = false;
  const commands = [];
  debug.attach = () => {
    attached = true;
  };
  debug.isAttached = () => attached;
  debug.detach = () => {
    attached = false;
    debug.emit('detach');
  };
  debug.sendCommand = async (method, params) => {
    commands.push({ method, params });
    return method === 'Network.getResponseBody' ? body : {};
  };
  const emit = (method, params) => debug.emit('message', {}, method, params);
  return { wc, debug, commands, emit };
}
test('passive observer reads collection only, never requests login bodies, and detaches cleanly', async () => {
  const payload = { status_code: 0, custom_sticker_page_list: { resources: [] } };
  const f = fixture({
    body: Buffer.from(JSON.stringify(payload)).toString('base64'),
    base64Encoded: true,
  });
  const seen = [],
    errors = [];
  const stop = await observeCollections(
    f.wc,
    (p) => seen.push(p),
    () => errors.push(true),
  );
  f.emit('Network.responseReceived', {
    requestId: 'login',
    response: { status: 200, url: 'https://www.douyin.com/passport/login/' },
  });
  f.emit('Network.loadingFinished', { requestId: 'login' });
  f.emit('Network.responseReceived', { requestId: 'collection', response: { status: 200, url } });
  f.emit('Network.loadingFinished', { requestId: 'collection', encodedDataLength: 50 });
  await tick();
  assert.deepEqual(seen, [payload]);
  assert.deepEqual(
    f.commands.filter((c) => c.method === 'Network.getResponseBody').map((c) => c.params.requestId),
    ['collection'],
  );
  stop();
  stop();
  assert.equal(f.debug.isAttached(), false);
  assert.equal(f.debug.listenerCount('message'), 0);
  assert.deepEqual(errors, []);
});
test('observer reports invalid/oversized collection and attach failure without leaking response text', async () => {
  const f = fixture({ body: 'not-json' });
  let errors = 0;
  const stop = await observeCollections(
    f.wc,
    () => assert.fail(),
    () => errors++,
  );
  for (const [id, size] of [
    ['invalid', 12],
    ['large', 9 * 1024 * 1024],
  ]) {
    f.emit('Network.responseReceived', { requestId: id, response: { status: 200, url } });
    f.emit('Network.loadingFinished', { requestId: id, encodedDataLength: size });
    await tick();
  }
  assert.equal(errors, 2);
  stop();
  const failed = fixture({});
  failed.debug.attach = () => {
    throw Error('private response');
  };
  await observeCollections(
    failed.wc,
    () => assert.fail(),
    () => errors++,
  );
  assert.equal(errors, 3);
});
test('closing collector ignores late response and clears listeners', async () => {
  const f = fixture({});
  let resolve;
  f.debug.sendCommand = (method) =>
    method === 'Network.enable'
      ? Promise.resolve({})
      : new Promise((r) => {
          resolve = r;
        });
  const seen = [];
  await observeCollections(
    f.wc,
    (p) => seen.push(p),
    () => assert.fail(),
  );
  f.emit('Network.responseReceived', { requestId: 'pending', response: { status: 200, url } });
  f.emit('Network.loadingFinished', { requestId: 'pending' });
  f.wc.emit('destroyed');
  resolve({ body: JSON.stringify({ status_code: 0, custom_sticker_page_list: {} }) });
  await tick();
  assert.deepEqual(seen, []);
  assert.equal(f.debug.listenerCount('message'), 0);
});
