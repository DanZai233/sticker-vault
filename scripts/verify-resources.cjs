const fs = require('node:fs/promises');
const path = require('node:path');
module.exports = async (context) => {
  if (!['darwin', 'win32'].includes(context.electronPlatformName)) return;
  const root =
    context.electronPlatformName === 'darwin'
      ? path.join(
          context.appOutDir,
          context.packager.appInfo.productFilename + '.app/Contents/Resources',
        )
      : path.join(context.appOutDir, 'resources');
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
