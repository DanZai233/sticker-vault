const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
function quoteDesktopArgument(value) {
  if (!path.isAbsolute(value) || /[\r\n\0]/.test(value)) throw Error('自动启动程序路径无效');
  // Exec has two escaping layers: quoted argument, then desktop-entry string.
  const argument = value.replace(/%/g, '%%').replace(/[\\"`$]/g, '\\$&');
  return '"' + argument.replace(/\\/g, '\\\\') + '"';
}
class StartupControl {
  constructor({
    app,
    platform = process.platform,
    home = os.homedir(),
    env = process.env,
    execPath = process.execPath,
  }) {
    this.app = app;
    this.platform = platform;
    this.execPath = platform === 'linux' && env.APPIMAGE ? env.APPIMAGE : execPath;
    const config =
      env.XDG_CONFIG_HOME && path.isAbsolute(env.XDG_CONFIG_HOME)
        ? env.XDG_CONFIG_HOME
        : path.join(home, '.config');
    this.file = path.join(config, 'autostart/stickervault.desktop');
    this.queue = Promise.resolve();
  }
  async get() {
    const supported = !!this.app.isPackaged && ['darwin', 'win32', 'linux'].includes(this.platform);
    if (!supported)
      return {
        supported: false,
        enabled: false,
        requested: false,
        message: '请使用安装版配置登录后自动启动。',
      };
    try {
      if (this.platform === 'linux') {
        let text;
        try {
          text = await fs.readFile(this.file, 'utf8');
        } catch (e) {
          if (e.code === 'ENOENT')
            return {
              supported: true,
              enabled: false,
              requested: false,
              message: '登录桌面后在后台启动。',
            };
          throw e;
        }
        const managed = /^X-StickerVault-Managed=true$/m.test(text);
        const enabled =
          !/^Hidden=true$/m.test(text) &&
          !/^X-GNOME-Autostart-enabled=false$/m.test(text) &&
          /^Exec=.+$/m.test(text);
        const needsUpdate =
          managed &&
          !text
            .split('\n')
            .includes('Exec=' + quoteDesktopArgument(this.execPath) + ' --background');
        return {
          supported: managed,
          enabled: enabled && !needsUpdate,
          requested: enabled,
          needsUpdate,
          message: needsUpdate
            ? '应用位置已改变，请更新启动项。'
            : managed
              ? '使用当前用户的桌面自动启动项。'
              : '同名启动项由其他工具创建，未修改；请先在系统启动设置中处理。',
        };
      }
      const settings =
        this.platform === 'win32'
          ? this.app.getLoginItemSettings({ path: this.execPath, args: ['--background'] })
          : this.app.getLoginItemSettings();
      const approval = settings.status === 'requires-approval';
      const requested = !!settings.openAtLogin || approval;
      const blocked =
        this.platform === 'win32' && requested && settings.executableWillLaunchAtLogin === false;
      return {
        supported: true,
        enabled: requested && !approval && !blocked,
        requested,
        requiresApproval: approval,
        blocked,
        message: approval
          ? '请在系统“登录项”中允许表情仓。'
          : blocked
            ? '启动项已登记，但被系统禁用；可关闭后重新开启。'
            : this.platform === 'darwin'
              ? '使用 macOS 系统登录项，登录后在菜单栏后台运行。'
              : '使用 Windows 当前用户启动项，登录后在托盘后台运行。',
      };
    } catch (e) {
      return {
        supported: true,
        enabled: false,
        requested: false,
        error: e.message,
        message: '读取系统启动设置失败：' + e.message,
      };
    }
  }
  set(enabled) {
    if (typeof enabled !== 'boolean') return Promise.reject(Error('无效的启动设置'));
    const task = this.queue.then(async () => {
      if (!this.app.isPackaged) throw Error('开发模式不注册启动项，请使用安装版。');
      if (!['darwin', 'win32', 'linux'].includes(this.platform))
        throw Error('当前平台不支持自动启动');
      if (this.platform === 'linux') {
        const before = await this.get();
        if (!before.supported) throw Error(before.message);
        if (enabled) {
          const text = [
            '[Desktop Entry]',
            'Type=Application',
            'Name=表情仓',
            'Exec=' + quoteDesktopArgument(this.execPath) + ' --background',
            'Terminal=false',
            'Hidden=false',
            'X-GNOME-Autostart-enabled=true',
            'X-StickerVault-Managed=true',
            '',
          ].join('\n');
          await fs.mkdir(path.dirname(this.file), { recursive: true });
          await fs.writeFile(this.file + '.tmp', text, { mode: 0o644 });
          await fs.rename(this.file + '.tmp', this.file);
        } else
          await fs.unlink(this.file).catch((e) => {
            if (e.code !== 'ENOENT') throw e;
          });
      } else if (this.platform === 'win32')
        this.app.setLoginItemSettings({
          openAtLogin: enabled,
          enabled,
          path: this.execPath,
          args: ['--background'],
          name: 'StickerVault',
        });
      else this.app.setLoginItemSettings({ openAtLogin: enabled });
      return this.get();
    });
    this.queue = task.catch(() => {});
    return task;
  }
}
module.exports = { StartupControl, quoteDesktopArgument };
