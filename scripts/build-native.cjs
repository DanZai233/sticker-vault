const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
if (process.platform === 'darwin') {
  const arch = process.argv[2] || process.arch;
  const dir = path.join(__dirname, '../vendor/native');
  fs.mkdirSync(dir, { recursive: true });
  execFileSync(
    'xcrun',
    [
      'swiftc',
      path.join(__dirname, 'macos-insert.swift'),
      '-O',
      '-target',
      (arch === 'arm64' ? 'arm64' : 'x86_64') + '-apple-macos12.0',
      '-o',
      path.join(dir, 'sticker-insert'),
    ],
    { stdio: 'inherit' },
  );
}
