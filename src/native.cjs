const path = require('node:path');
const { promisify } = require('node:util');
const execFile = promisify(require('node:child_process').execFile);
const { clipboard } = require('electron');
const helper = () =>
  __dirname.includes(path.sep + 'app.asar' + path.sep)
    ? path.join(__dirname, '../../native/sticker-insert')
    : path.join(__dirname, '../vendor/native/sticker-insert');
async function native(args) {
  const { stdout } = await execFile(helper(), args, { timeout: 5000 });
  return JSON.parse(stdout);
}
async function frontmost() {
  return process.platform === 'darwin' ? (await native(['frontmost'])).pid : 0;
}
async function insert(file, pid) {
  if (process.platform === 'darwin')
    return native([pid ? 'insert' : 'copy', file, String(pid || 0)]);
  if (process.platform === 'win32') {
    const ps =
      'Add-Type -AssemblyName System.Windows.Forms; $list=New-Object System.Collections.Specialized.StringCollection; [void]$list.Add($env:STICKER_FILE); [System.Windows.Forms.Clipboard]::SetFileDropList($list)';
    await execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-STA', '-Command', ps], {
      windowsHide: true,
      env: { ...process.env, STICKER_FILE: file },
      timeout: 10000,
    });
    return { copied: true, pasted: false };
  }
  const uri = require('node:url').pathToFileURL(file).href;
  clipboard.writeBuffer('text/uri-list', Buffer.from(uri + '\r\n'));
  clipboard.writeBuffer('x-special/gnome-copied-files', Buffer.from('copy\n' + uri));
  return { copied: true, pasted: false };
}
module.exports = {
  frontmost,
  insert,
  authorize: () =>
    process.platform === 'darwin' ? native(['authorize']) : Promise.resolve({ trusted: false }),
};
