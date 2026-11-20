const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sticker-desktop-flow-'));
let status = 1;
try {
  const packaged = process.env.STICKER_DESKTOP_APP;
  const args = packaged
    ? []
    : [...(process.platform === 'linux' ? ['--no-sandbox'] : []), path.join(__dirname, '..')];
  const result = spawnSync(packaged || require('electron'), args, {
    stdio: 'inherit',
    timeout: 60000,
    env: {
      ...process.env,
      STICKER_GALLERY_SMOKE: '1',
      STICKER_TEST_ROOT: path.join(root, 'profile'),
      STICKER_FIXTURE: path.join(__dirname, '../test/fixtures/ocr-text.png'),
    },
  });
  status = result.status ?? 1;
  if (result.error) console.error(result.error.message);
} finally {
  try {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  } catch {}
}
process.exit(status);
