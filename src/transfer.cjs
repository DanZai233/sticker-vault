const { exportBackup, stageBackup, mergeStaged } = require('./backup.cjs');
const { DavSettings, WebDavSync } = require('./webdav.cjs');
class Transfers {
  constructor(
    lib,
    { root, safeStorage, config = () => ({}), notify = () => {}, afterMerge = () => {} },
  ) {
    Object.assign(this, { lib, config, notify, afterMerge });
    this.settings = new DavSettings(root, safeStorage);
    this.status = { busy: false, phase: 'idle', message: '仅手动同步，不自动上传或下载。' };
    this.dav = new WebDavSync(lib, this.settings, {
      config,
      progress: (update) => this.progress(update),
      afterMerge,
    });
  }
  async init() {
    await this.settings.init();
    return this;
  }
  snapshot() {
    return {
      dav: this.settings.public(),
      transfer: this.status,
      migrationHints: this.lib.data.migrationHints || {},
    };
  }
  emit() {
    this.notify(this.snapshot());
  }
  progress(update) {
    this.status = { ...this.status, ...update };
    const now = Date.now();
    if (!this.lastEmit || now - this.lastEmit >= 100) {
      this.lastEmit = now;
      this.emit();
    }
  }
  async run(kind, fn) {
    if (this.status.busy) throw Error('已有备份或同步任务正在进行，请等待完成。');
    this.status = { busy: true, kind, phase: 'preparing', message: '' };
    this.emit();
    try {
      const result = await fn();
      this.status = {
        busy: false,
        phase: 'done',
        kind,
        message: result?.message || '操作完成。',
        result,
      };
      this.emit();
      return result;
    } catch (error) {
      this.status = { busy: false, kind, phase: 'error', message: error.message };
      this.emit();
      throw error;
    }
  }
  async save(input) {
    if (this.status.busy) throw Error('请等待当前任务完成后修改连接。');
    const result = await this.settings.save(input);
    this.emit();
    return result;
  }
  async forget() {
    if (this.status.busy) throw Error('请等待当前任务完成。');
    const result = await this.settings.forget();
    this.emit();
    return result;
  }
  export(file) {
    return this.run('export', async () => ({
      ...(await exportBackup(this.lib, file, {
        config: this.config(),
        progress: (update) => this.progress(update),
      })),
      message: '完整备份已导出，包含原件与便携配置；不包含密码和登录态。',
    }));
  }
  import(file, confirm) {
    return this.run('import', async () => {
      const staged = await stageBackup(file, { progress: (update) => this.progress(update) });
      try {
        const options = await confirm(staged.manifest);
        if (!options) return { canceled: true, message: '已取消导入，现有素材未修改。' };
        const result = await mergeStaged(this.lib, staged, options);
        await this.afterMerge();
        if (
          options.restoreSettings &&
          !this.settings.config.url &&
          staged.manifest.config.webdav?.url
        ) {
          try {
            await this.settings.save({ ...staged.manifest.config.webdav, password: '' });
          } catch {
            result.connectionNeedsSetup = true;
          }
        }
        return {
          ...result,
          message: `已合并导入：新增 ${result.added} 个，合并重复 ${result.merged} 个，现共 ${result.total} 个。原有内容保留；目录、平台登录及密码请在此设备重新配置。`,
        };
      } finally {
        await staged.cleanup();
      }
    });
  }
  test() {
    return this.run('test', () => this.dav.test());
  }
  sync() {
    return this.run('sync', () => this.dav.run());
  }
  cancel() {
    this.dav.cancel();
  }
}
module.exports = { Transfers };
