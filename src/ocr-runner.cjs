const os = require('node:os');
const path = require('node:path');
class OcrRunner {
  constructor({
    spawnHost,
    modelsPath,
    hostPath = path.join(__dirname, 'ocr-host.cjs'),
    initTimeout = 120000,
    jobTimeout = 60000,
  }) {
    Object.assign(this, { spawnHost, modelsPath, hostPath, initTimeout, jobTimeout });
    this.pending = new Map();
    this.nextId = 0;
    this.healthy = false;
  }
  fail(error) {
    this.healthy = false;
    for (const job of this.pending.values()) {
      clearTimeout(job.timer);
      job.reject(error);
    }
    this.pending.clear();
    this.ready = null;
  }
  request(message, timeout) {
    return new Promise((resolve, reject) => {
      const id = ++this.nextId;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(Error('OCR 后台处理超时'));
        this.stop();
      }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      try {
        const value = { ...message, id };
        if (this.child.postMessage) this.child.postMessage(value);
        else this.child.send(value);
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(e);
      }
    });
  }
  prepare() {
    if (this.ready) return this.ready;
    this.ready = this.start().catch((error) => {
      this.stop();
      throw error;
    });
    return this.ready;
  }
  async start() {
    const child = (this.child = this.spawnHost(this.hostPath));
    this.healthy = true;
    // Drain worker diagnostics so a full pipe cannot stall recognition.
    child.stdout?.resume();
    child.stderr?.resume();
    const lowerPriority = () => {
      if (child?.pid)
        try {
          os.setPriority(child.pid, os.constants.priority.PRIORITY_BELOW_NORMAL);
        } catch {}
    };
    lowerPriority();
    this.child.once('spawn', lowerPriority);
    this.child.on('message', (message) => {
      if (this.child !== child) return;
      const job = this.pending.get(message.id);
      if (!job) return;
      this.pending.delete(message.id);
      clearTimeout(job.timer);
      if (message.type === 'failed') {
        job.reject(Error(message.error || 'OCR 识别失败'));
        if (message.fatal) this.fail(Error(message.error));
      } else job.resolve(message.result || true);
    });
    this.child.once('exit', () => {
      if (this.child === child) this.fail(Error('OCR 后台进程已退出'));
    });
    this.child.once('error', (error) => {
      if (this.child === child) this.fail(error);
    });
    await this.request({ type: 'init', modelsPath: this.modelsPath }, this.initTimeout);
  }
  async recognize(image) {
    await this.prepare();
    return this.request({ type: 'recognize', image }, this.jobTimeout);
  }
  stop() {
    const child = this.child;
    this.child = null;
    this.fail(Error('OCR 后台处理已停止'));
    child?.kill();
  }
}
module.exports = { OcrRunner };
