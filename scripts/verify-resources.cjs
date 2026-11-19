const fs = require('node:fs/promises');
const path = require('node:path');
module.exports = async (context) => {
  const root =
    context.electronPlatformName === 'darwin'
      ? path.join(
          context.appOutDir,
          context.packager.appInfo.productFilename + '.app/Contents/Resources',
        )
      : path.join(context.appOutDir, 'resources');
  for (const language of ['chi_sim', 'eng']) {
    const stat = await fs.stat(path.join(root, 'ocr-data', language + '.traineddata.gz'));
    if (stat.size < 100000) throw Error('Missing bundled OCR model: ' + language);
  }
  await fs.access(path.join(root, 'app.asar.unpacked/src/ocr-host.cjs'));
  await fs.access(
    path.join(root, 'app.asar.unpacked/node_modules/tesseract.js/src/worker-script/node/index.js'),
  );
  if (!['darwin', 'win32'].includes(context.electronPlatformName)) return;
  const file = path.join(
    root,
    'wxemoticon',
    context.electronPlatformName === 'win32' ? 'wxemoticon.exe' : 'wxemoticon',
  );
  const stat = await fs.stat(file);
  if (stat.size < 100000) throw Error('Missing or incomplete bundled WeChat helper: ' + file);
  if (context.electronPlatformName === 'win32') {
    const f = await fs.open(file);
    try {
      const magic = Buffer.alloc(2);
      await f.read(magic, 0, 2, 0);
      if (magic.toString() !== 'MZ') throw Error('Bundled Windows helper is not an EXE');
    } finally {
      await f.close();
    }
  }
};
