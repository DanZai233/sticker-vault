const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const assets = {
  darwin: {
    arm64: [
      'wxemoticon-aarch64-apple-darwin.tar.gz',
      'd36cbcc546e88f3c112172688efb7845da13cc31761b5a33e2e877628f9cbb4b',
    ],
    x64: [
      'wxemoticon-x86_64-apple-darwin.tar.gz',
      'b3d25142a013340dde8041b72f4ba9eb521801ce1229d08c0a27b3053e69b72d',
    ],
  },
  win32: {
    x64: [
      'wxemoticon-x86_64-windows.zip',
      'ceb10c0b2052716cc493e5446d3cb59d1b3090d2b64014ad6ddc7b3b28a033d0',
    ],
    arm64: [
      'wxemoticon-x86_64-windows.zip',
      'ceb10c0b2052716cc493e5446d3cb59d1b3090d2b64014ad6ddc7b3b28a033d0',
    ],
  },
};
(async () => {
  const platform = process.argv[2] || process.platform,
    arch = process.argv[3] || process.arch;
  const dir = path.join(__dirname, '../vendor/wxemoticon');
  await fs.mkdir(dir, { recursive: true });
  for (const file of ['wxemoticon', 'wxemoticon.exe'])
    await fs.rm(path.join(dir, file), { force: true });
  if (!assets[platform]) {
    console.log('No WeChat helper for ' + platform);
    return;
  }
  if (!assets[platform][arch]) throw Error('Unsupported helper architecture');
  const [name, expected] = assets[platform][arch];
  const response = await fetch(
    'https://github.com/liusheng22/export-wechat-emoji/releases/download/v0.3.0/' + name,
    { signal: AbortSignal.timeout(120000) },
  );
  if (!response.ok) throw Error('Helper download failed: ' + response.status);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (crypto.createHash('sha256').update(bytes).digest('hex') !== expected)
    throw Error('Helper SHA-256 mismatch');
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'sticker-helper-'));
  try {
    const archive = path.join(temp, name);
    await fs.writeFile(archive, bytes);
    if (platform === 'win32' && process.platform === 'win32') {
      execFileSync(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          'Expand-Archive -LiteralPath $env:STICKER_HELPER_ARCHIVE -DestinationPath $env:STICKER_HELPER_DEST',
        ],
        {
          env: { ...process.env, STICKER_HELPER_ARCHIVE: archive, STICKER_HELPER_DEST: temp },
          stdio: 'inherit',
          windowsHide: true,
        },
      );
    } else execFileSync('tar', ['-xf', archive, '-C', temp]);
    const executable = platform === 'win32' ? 'wxemoticon.exe' : 'wxemoticon';
    await fs.copyFile(path.join(temp, executable), path.join(dir, executable));
    if (platform === 'darwin') await fs.chmod(path.join(dir, executable), 0o755);
    console.log('Verified wxemoticon 0.3.0 for ' + platform + ' ' + arch);
  } finally {
    await fs.rm(temp, { recursive: true, force: true });
  }
})().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
