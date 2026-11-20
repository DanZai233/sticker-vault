// Observe only collection responses. Never inject scripts or inspect login request bodies.
const MAX_BODY = 8 * 1024 * 1024;
function trustedNavigation(raw) {
  try {
    const u = new URL(raw);
    return (
      u.protocol === 'https:' &&
      !u.username &&
      !u.password &&
      (!u.port || u.port === '443') &&
      (u.hostname === 'douyin.com' || u.hostname.endsWith('.douyin.com'))
    );
  } catch {
    return false;
  }
}
function collectionURL(raw) {
  try {
    const u = new URL(raw);
    return (
      trustedNavigation(raw) &&
      u.hostname === 'www.douyin.com' &&
      u.pathname.replace(/\/$/, '') === '/aweme/v1/web/im/resource/list/aggregation' &&
      u.searchParams.get('scenes') === 'CUSTOM_STICKER_PAGE'
    );
  } catch {
    return false;
  }
}
async function observeCollections(contents, onCollection, onError) {
  const pending = new Set();
  const debug = contents.debugger;
  let stopped = false;
  const fail = () => {
    if (!stopped) onError();
  };
  const message = async (_, method, p) => {
    if (stopped) return;
    if (method === 'Network.responseReceived') {
      if (p.response?.status === 200 && collectionURL(p.response.url) && pending.size < 128)
        pending.add(p.requestId);
      return;
    }
    if (method === 'Network.loadingFailed') {
      pending.delete(p.requestId);
      return;
    }
    if (method !== 'Network.loadingFinished' || !pending.delete(p.requestId)) return;
    if (p.encodedDataLength > MAX_BODY) {
      fail();
      return;
    }
    try {
      const result = await debug.sendCommand('Network.getResponseBody', { requestId: p.requestId });
      if (stopped) return;
      if (typeof result.body !== 'string' || result.body.length > MAX_BODY * 1.4) throw Error();
      const body = result.base64Encoded
        ? Buffer.from(result.body, 'base64')
        : Buffer.from(result.body);
      if (body.length > MAX_BODY) throw Error();
      const data = JSON.parse(body.toString('utf8'));
      if (data?.status_code !== 0 || !data.custom_sticker_page_list) throw Error();
      onCollection(data);
    } catch {
      fail();
    }
  };
  const detached = () => fail();
  const stop = () => {
    if (stopped) return;
    stopped = true;
    pending.clear();
    debug.removeListener('message', message);
    debug.removeListener('detach', detached);
    contents.removeListener('destroyed', stop);
    try {
      if (debug.isAttached()) debug.detach();
    } catch {}
  };
  try {
    debug.attach('1.3');
    debug.on('message', message);
    debug.on('detach', detached);
    contents.once('destroyed', stop);
    let timeout;
    try {
      await Promise.race([
        debug.sendCommand('Network.enable', {
          maxTotalBufferSize: MAX_BODY * 2,
          maxResourceBufferSize: MAX_BODY,
        }),
        new Promise((_, reject) => {
          timeout = setTimeout(() => reject(Error('observer timeout')), 5000);
        }),
      ]);
    } finally {
      clearTimeout(timeout);
    }
  } catch {
    fail();
    stop();
  }
  return stop;
}
module.exports = { trustedNavigation, collectionURL, observeCollections };
