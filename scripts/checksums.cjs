const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
(async () => {
  const dir = path.join(__dirname, '../dist');
  const files = (await fs.readdir(dir))
    .filter((n) => /\.(dmg|zip|exe|AppImage|deb)$/.test(n))
    .sort();
  if (!files.length) throw Error('No installers found');
  const rows = [];
  for (const name of files)
    rows.push(
      createHash('sha256')
        .update(await fs.readFile(path.join(dir, name)))
        .digest('hex') +
        '  ' +
        name,
    );
  await fs.writeFile(
    path.join(dir, `SHA256SUMS-${process.platform}-${process.env.BUILD_ARCH || process.arch}.txt`),
    rows.join('\n') + '\n',
  );
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
