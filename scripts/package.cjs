(async () => {
  const { packager } = await import('@electron/packager');
  const path = require('node:path');
  const out = await packager({
    dir: path.join(__dirname, '..'),
    name: 'StickerVault',
    platform: 'darwin',
    arch: 'arm64',
    out: path.join(__dirname, '../../../work/build'),
    overwrite: true,
    icon: path.join(__dirname, '../assets/icon.icns'),
    asar: true,
    extraResource: [
      path.join(__dirname, '../vendor/wxemoticon'),
      path.join(__dirname, '../vendor/native'),
    ],
    ignore: [/^\/test/, /^\/vendor/],
    appBundleId: 'com.electron.stickervault',
  });
  console.log(out.join('\n'));
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
