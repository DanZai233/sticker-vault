const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const assets = {
  arm64: [
    'wxemoticon-aarch64-apple-darwin.tar.gz',
    'd36cbcc546e88f3c112172688efb7845da13cc31761b5a33e2e877628f9cbb4b',
  ],
  x64: [
    'wxemoticon-x86_64-apple-darwin.tar.gz',
    'b3d25142a013340dde8041b72f4ba9eb521801ce1229d08c0a27b3053e69b72d',
  ],
};
(async () => {
  const platform = process.argv[2] || process.platform,
    arch = process.argv[3] || process.arch;
  const dir = path.join(__dirname, '../vendor/wxemoticon');
  await fs.mkdir(dir, { recursive: true });
  if (platform !== 'darwin') {
    await fs.rm(path.join(dir, 'wxemoticon'), { force: true });
    console.log('WeChat helper is macOS-only; skipping.');
    return;
  }
  if (!assets[arch]) throw Error('Unsupported helper architecture: ' + arch);
  const [name, expected] = assets[arch];
  const response = await fetch(
    'https://github.com/liusheng22/export-wechat-emoji/releases/download/v0.3.0/' + name,
    { signal: AbortSignal.timeout(120000) },
  );
  if (!response.ok) throw Error('Download failed: ' + response.status);
  const b = Buffer.from(await response.arrayBuffer());
  if (crypto.createHash('sha256').update(b).digest('hex') !== expected)
    throw Error('Helper SHA-256 mismatch');
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'sticker-helper-'));
  try {
    const archive = path.join(temp, 'helper.tar.gz');
    await fs.writeFile(archive, b);
    const entries = execFileSync('tar', ['-tzf', archive], { encoding: 'utf8' }).trim().split('\n');
    if (entries.length !== 1 || entries[0] !== 'wxemoticon')
      throw Error('Unexpected archive contents');
    execFileSync('tar', ['-xzf', archive, '-C', temp]);
    await fs.copyFile(path.join(temp, 'wxemoticon'), path.join(dir, 'wxemoticon'));
    await fs.chmod(path.join(dir, 'wxemoticon'), 0o755);
    console.log('Verified wxemoticon 0.3.0 for macOS ' + arch);
  } finally {
    await fs.rm(temp, { recursive: true, force: true });
  }
})().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
