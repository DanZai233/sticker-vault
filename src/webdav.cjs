const fs = require('node:fs/promises');
const fss = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const os = require('node:os');
const { Readable, Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { exportBackup, stageBackup, mergeStaged, MAX_TOTAL } = require('./backup.cjs');
function normalizeUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw Error('请输入有效的 WebDAV 目录地址');
  }
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw Error('WebDAV 地址须为 HTTP / HTTPS 目录，账号密码请在单独字段填写');
  if (!url.pathname.endsWith('/')) url.pathname += '/';
  return url.href;
}
class DavSettings {
  constructor(root, safeStorage) {
    this.file = path.join(root, 'webdav.json');
    this.safeStorage = safeStorage;
    this.secret = '';
    this.config = { url: '', username: '' };
  }
  secure() {
    return (
      this.safeStorage?.isEncryptionAvailable() &&
      this.safeStorage.getSelectedStorageBackend?.() !== 'basic_text'
    );
  }
  async init() {
    try {
      const data = JSON.parse(await fs.readFile(this.file, 'utf8'));
      this.config = {
        url: data.url ? normalizeUrl(data.url) : '',
        username: String(data.username || ''),
        lastSyncAt: data.lastSyncAt || 0,
      };
      if (data.encryptedPassword && this.secure())
        try {
          this.secret = this.safeStorage.decryptString(
            Buffer.from(data.encryptedPassword, 'base64'),
          );
        } catch {
          this.unlockError = true;
        }
    } catch (error) {
      if (error.code !== 'ENOENT') this.loadError = '无法读取本机 WebDAV 配置，请重新保存。';
    }
    return this;
  }
  public() {
    return {
      ...this.config,
      hasPassword: !!this.secret,
      passwordPersistent: !!this.secret && !!this.secure(),
      message: this.unlockError
        ? '密码无法解锁，请重新输入。'
        : this.loadError ||
          (!this.secure()
            ? '系统安全存储不可用，密码仅保留本次运行。'
            : '密码由本机系统安全存储保护，不进入备份。'),
    };
  }
  async save(input) {
    const url = normalizeUrl(String(input.url || '').trim()),
      username = String(input.username || '').slice(0, 300);
    if (username.includes(':') || /[\r\n]/.test(username))
      throw Error('WebDAV 用户名不能包含冒号或换行');
    if (typeof input.password !== 'undefined' && typeof input.password !== 'string')
      throw Error('密码格式无效');
    const secret =
      input.password ||
      (url === this.config.url && username === this.config.username ? this.secret : '');
    const next = {
      url,
      username,
      lastSyncAt:
        url === this.config.url && username === this.config.username
          ? this.config.lastSyncAt || 0
          : 0,
    };
    await this.write(next, secret);
    this.config = next;
    this.secret = secret;
    this.unlockError = false;
    this.loadError = '';
    return this.public();
  }
  async write(config, secret) {
    const data = { ...config };
    if (secret && this.secure())
      data.encryptedPassword = this.safeStorage.encryptString(secret).toString('base64');
    const temporary = this.file + '.' + crypto.randomUUID() + '.tmp';
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    try {
      await fs.writeFile(temporary, JSON.stringify(data), { mode: 0o600, flag: 'wx' });
      await fs.rename(temporary, this.file);
    } finally {
      await fs.unlink(temporary).catch(() => {});
    }
  }
  async forget() {
    await this.write(this.config, '');
    this.secret = '';
    this.unlockError = false;
    return this.public();
  }
  async synced() {
    const next = { ...this.config, lastSyncAt: Date.now() };
    await this.write(next, this.secret);
    this.config = next;
  }
}
class WebDavSync {
  constructor(
    lib,
    settings,
    { fetchImpl = fetch, progress = () => {}, config = () => ({}), afterMerge = () => {} } = {},
  ) {
    Object.assign(this, { lib, settings, fetchImpl, progress, config, afterMerge });
  }
  cancel() {
    this.controller?.abort();
  }
  async request(method, url, { headers = {}, body, signal } = {}) {
    const auth =
      this.settings.config.username || this.settings.secret
        ? {
            Authorization:
              'Basic ' +
              Buffer.from(this.settings.config.username + ':' + this.settings.secret).toString(
                'base64',
              ),
          }
        : {};
    try {
      return await this.fetchImpl(url, {
        method,
        headers: { ...auth, ...headers },
        body,
        redirect: 'manual',
        signal: AbortSignal.any([
          signal || new AbortController().signal,
          AbortSignal.timeout(600000),
        ]),
        ...(body ? { duplex: 'half' } : {}),
      });
    } catch (error) {
      if (error.name === 'AbortError') throw Error('已取消同步');
      throw Error('WebDAV 请求失败，请检查地址、网络和证书。');
    }
  }
  async status(response, label, allowed) {
    if (allowed.includes(response.status)) return;
    await response.body?.cancel().catch(() => {});
    throw Error(
      label +
        '失败（HTTP ' +
        response.status +
        '）' +
        ([401, 403].includes(response.status)
          ? '，请检查账号、密码和目录权限。'
          : response.status >= 300 && response.status < 400
            ? '；服务器返回重定向，请填写最终目录地址。'
            : ''),
    );
  }
  async directory(signal, { create = false } = {}) {
    const url = normalizeUrl(this.settings.config.url);
    let response = await this.request('PROPFIND', url, { headers: { Depth: '0' }, signal });
    if (response.status === 404 && create) {
      await response.body?.cancel();
      response = await this.request('MKCOL', url, { signal });
      await this.status(response, '创建远端目录', [201, 405]);
    } else await this.status(response, '连接目录', [200, 207]);
    await response.body?.cancel();
    return url;
  }
  async test() {
    if (this.controller) throw Error('已有连接任务正在进行');
    this.controller = new AbortController();
    try {
      const directory = await this.directory(this.controller.signal, { create: true });
      await this.verifyConditions(directory, this.controller.signal);
      return { message: '连接成功，目录读写及条件写入保护已验证。', directory };
    } finally {
      this.controller = null;
    }
  }
  async verifyConditions(base, signal) {
    const probe = new URL('stickervault-check-' + crypto.randomUUID() + '.tmp', base).href;
    try {
      let response = await this.request('PUT', probe, {
        headers: { 'If-None-Match': '*' },
        body: Buffer.from('StickerVault sync capability check'),
        signal,
      });
      await this.status(response, '验证同步写入权限', [201, 200, 204]);
      await response.body?.cancel();
      for (const condition of [
        { 'If-None-Match': '*' },
        { 'If-Match': '"stickervault-impossible-' + crypto.randomUUID() + '"' },
      ]) {
        response = await this.request('PUT', probe, {
          headers: condition,
          body: Buffer.from('StickerVault sync capability check'),
          signal,
        });
        const valid = response.status === 412;
        await response.body?.cancel();
        if (!valid) throw Error('服务器不支持条件写入保护，已停止同步，未覆盖远端备份。');
      }
    } finally {
      try {
        const response = await this.request('DELETE', probe, { signal: AbortSignal.timeout(5000) });
        await response.body?.cancel();
      } catch {}
    }
  }
  async run() {
    if (this.controller) throw Error('已有同步正在进行');
    this.controller = new AbortController();
    const signal = this.controller.signal;
    const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'sticker-dav-'));
    let localMerged = false,
      conditionsVerified = false;
    try {
      this.progress({ phase: 'connecting' });
      const base = await this.directory(signal, { create: true }),
        url = new URL('stickervault-v1.zip', base).href;
      for (let attempt = 0; attempt < 3; attempt++) {
        signal.throwIfAborted();
        this.progress({ phase: 'downloading', attempt });
        const response = await this.request('GET', url, { signal });
        let etag = null,
          exists = response.status !== 404;
        if (exists) {
          await this.status(response, '下载远端备份', [200]);
          etag = response.headers.get('etag');
          if (!etag || !/^"[^"\r\n]+"$/.test(etag)) {
            await response.body?.cancel();
            throw Error(
              '服务器未返回有效的强 ETag，无法防止覆盖其他设备；已停止同步，未写入远端。',
            );
          }
          const disk = await fs.statfs(temp);
          const limit = Math.min(
              MAX_TOTAL + 128 * 1024 * 1024,
              Math.max(0, Number(disk.bavail) * Number(disk.bsize) - 256 * 1024 * 1024),
            ),
            length = Number(response.headers.get('content-length') || 0);
          if (length > limit) {
            await response.body?.cancel();
            throw Error('远端备份过大');
          }
          const remoteFile = path.join(temp, 'remote.zip');
          let received = 0;
          const meter = new Transform({
            transform: (chunk, encoding, callback) => {
              received += chunk.length;
              this.progress({ phase: 'downloading', bytes: received, byteTotal: length });
              callback(received > limit ? Error('远端备份过大') : null, chunk);
            },
          });
          if (!response.body) throw Error('服务器没有返回备份内容');
          await pipeline(
            Readable.fromWeb(response.body),
            meter,
            fss.createWriteStream(remoteFile),
            { signal },
          );
          const staged = await stageBackup(remoteFile, { progress: this.progress, signal });
          try {
            signal.throwIfAborted();
            await mergeStaged(this.lib, staged);
            localMerged = true;
            await this.afterMerge();
          } finally {
            await staged.cleanup();
          }
        } else await response.body?.cancel();
        signal.throwIfAborted();
        if (!this.lib.data.items.length && !exists)
          return { message: '两端均为空，未上传空备份。', count: 0 };
        if (!conditionsVerified) {
          this.progress({ phase: 'checking' });
          await this.verifyConditions(base, signal);
          conditionsVerified = true;
        }
        const localFile = path.join(temp, 'upload.zip');
        const exported = await exportBackup(this.lib, localFile, {
          config: this.config(),
          progress: this.progress,
          signal,
        });
        signal.throwIfAborted();
        let sent = 0;
        this.progress({ phase: 'uploading', bytes: 0, byteTotal: exported.bytes });
        const meter = new Transform({
          transform: (chunk, encoding, callback) => {
            sent += chunk.length;
            this.progress({ phase: 'uploading', bytes: sent, byteTotal: exported.bytes });
            callback(null, chunk);
          },
        });
        const body = fss.createReadStream(localFile);
        body.on('error', (error) => meter.destroy(error));
        body.pipe(meter);
        let uploaded;
        try {
          uploaded = await this.request('PUT', url, {
            headers: {
              'Content-Type': 'application/zip',
              'Content-Length': String(exported.bytes),
              ...(exists ? { 'If-Match': etag } : { 'If-None-Match': '*' }),
            },
            body: meter,
            signal,
          });
        } finally {
          body.destroy();
          meter.destroy();
        }
        if (uploaded.status === 412) {
          await uploaded.body?.cancel();
          this.progress({ phase: 'conflict', attempt });
          continue;
        }
        await this.status(uploaded, '上传合并备份', [200, 201, 204]);
        await uploaded.body?.cancel();
        await this.settings.synced();
        return { message: '手动同步完成：已合并两端内容，未传播删除。', count: exported.count };
      }
      throw Error('远端连续被其他设备更新，已停止上传；请稍后再次手动同步。');
    } catch (error) {
      throw Error(
        (localMerged ? '已取回远端内容，但上传未完成。本机数据已保留。' : '') +
          (signal.aborted ? '已取消同步。' : error.message),
      );
    } finally {
      this.controller = null;
      await fs.rm(temp, { recursive: true, force: true });
    }
  }
}
module.exports = { DavSettings, WebDavSync, normalizeUrl };
