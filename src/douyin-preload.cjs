const { ipcRenderer, contextBridge } = require('electron');
window.addEventListener('message', (e) => {
  if (
    e.source !== window ||
    e.origin !== 'https://www.douyin.com' ||
    e.data?.kind !== 'sticker-vault-collection'
  )
    return;
  ipcRenderer.send('douyin-collection', e.data.payload);
});
if (location.origin === 'https://www.douyin.com')
  contextBridge.executeInMainWorld({
    func: () => {
      if (window.__stickerVaultHook) return;
      window.__stickerVaultHook = true;
      const matches = (raw) => {
        try {
          const u = new URL(raw, location.href);
          return (
            u.hostname === 'www.douyin.com' &&
            u.pathname.replace(/\/$/, '') === '/aweme/v1/web/im/resource/list/aggregation' &&
            u.searchParams.get('scenes') === 'CUSTOM_STICKER_PAGE'
          );
        } catch {
          return false;
        }
      };
      const emit = (data) =>
        window.postMessage({ kind: 'sticker-vault-collection', payload: data }, location.origin);
      const original = window.fetch;
      window.fetch = async function (...args) {
        const response = await original.apply(this, args);
        if (matches(response.url))
          response
            .clone()
            .json()
            .then(emit)
            .catch(() => {});
        return response;
      };
      const open = XMLHttpRequest.prototype.open;
      XMLHttpRequest.prototype.open = function (method, url, ...rest) {
        if (matches(url))
          this.addEventListener(
            'load',
            () => {
              try {
                emit(this.responseType === 'json' ? this.response : JSON.parse(this.responseText));
              } catch {}
            },
            { once: true },
          );
        return open.call(this, method, url, ...rest);
      };
    },
  });
