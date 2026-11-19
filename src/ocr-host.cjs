const { createWorker } = require('tesseract.js');
const fs = require('node:fs/promises');
const path = require('node:path');
let worker;
const send = (message) =>
  process.parentPort ? process.parentPort.postMessage(message) : process.send?.(message);
async function handle(message) {
  try {
    if (message.type === 'init') {
      for (const lang of ['chi_sim', 'eng'])
        await fs.access(path.join(message.modelsPath, lang + '.traineddata.gz'));
      worker = await createWorker('chi_sim+eng', 1, {
        langPath: message.modelsPath,
        cacheMethod: 'none',
        gzip: true,
        logger: () => {},
        errorHandler: () => {},
      });
      await worker.setParameters({
        tessedit_pageseg_mode: '11',
        preserve_interword_spaces: '1',
        user_defined_dpi: '300',
      });
      send({ id: message.id, type: 'ready' });
    } else if (message.type === 'recognize') {
      if (!worker) throw Error('OCR 引擎未准备');
      const image = Buffer.from(message.image.data || message.image);
      const result = await worker.recognize(image);
      send({
        id: message.id,
        type: 'result',
        result: {
          text: String(result.data.text || '').slice(0, 4000),
          confidence: result.data.confidence,
        },
      });
    }
  } catch (error) {
    send({
      id: message.id,
      type: 'failed',
      fatal: message.type === 'init',
      error: String(error.message || error).slice(0, 300),
    });
  }
}
if (process.parentPort) process.parentPort.on('message', (event) => handle(event.data));
else process.on('message', handle);
