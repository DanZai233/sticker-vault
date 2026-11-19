const { BrowserWindow } = require('electron');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
class OcrImageExtractor {
  async read(file) {
    if (!this.win || this.win.isDestroyed()) {
      this.win = new BrowserWindow({
        width: 1,
        height: 1,
        show: false,
        skipTaskbar: true,
        webPreferences: {
          nodeIntegration: false,
          contextIsolation: true,
          sandbox: true,
          offscreen: true,
          backgroundThrottling: false,
        },
      });
      this.win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      this.win.webContents.on('will-navigate', (event) => event.preventDefault());
      await this.win.loadFile(path.join(__dirname, 'ocr-frame.html'));
    }
    const page = this.win.webContents;
    let timer;
    const died = new Promise((_, reject) => {
      this.onCrash = () => reject(Error('图片解码进程已停止'));
      page.once('render-process-gone', this.onCrash);
    });
    try {
      const data = await Promise.race([
        page.executeJavaScript(
          'window.extractOcrFrame(' + JSON.stringify(pathToFileURL(file).href) + ')',
        ),
        died,
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(Error('图片解码超时')), 15000);
        }),
      ]);
      return Buffer.from(data.split(',')[1], 'base64');
    } catch (e) {
      this.stop();
      throw e;
    } finally {
      clearTimeout(timer);
      page.removeListener('render-process-gone', this.onCrash);
    }
  }
  stop() {
    if (this.win && !this.win.isDestroyed()) this.win.destroy();
    this.win = null;
  }
}
module.exports = { OcrImageExtractor };
