const fs = require('node:fs/promises');
const path = require('node:path');
(async () => {
  const out = path.join(__dirname, '../vendor/ocr-data');
  await fs.mkdir(out, { recursive: true });
  for (const lang of ['chi_sim', 'eng']) {
    const root = path.dirname(require.resolve('@tesseract.js-data/' + lang + '/package.json'));
    await fs.copyFile(
      path.join(root, '4.0.0_best_int', lang + '.traineddata.gz'),
      path.join(out, lang + '.traineddata.gz'),
    );
  }
  await fs.copyFile(
    path.join(path.dirname(require.resolve('tesseract.js/package.json')), 'LICENSE.md'),
    path.join(out, 'LICENSE-Tesseract.txt'),
  );
  console.log('Bundled offline Chinese and English OCR models prepared');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
