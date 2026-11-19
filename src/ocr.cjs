const path = require('node:path');
function tagsFromText(raw, confidence = 100) {
  const text = String(raw || '')
    .normalize('NFKC')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 4000);
  if (!text || confidence < 30) return { text, tags: [] };
  const tags = [],
    seen = new Set(),
    stop = new Set([
      '这个',
      '那个',
      '一个',
      '我们',
      '你们',
      '他们',
      '什么',
      '就是',
      '然后',
      '可以',
      '没有',
      'the',
      'and',
      'that',
      'this',
      'with',
    ]);
  function add(value) {
    const s = value
      .replace(/[^\p{L}\p{N}\s]/gu, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    const key = s.toLowerCase();
    if (s.length < 2 || s.length > 24 || /^\d+$/.test(s) || seen.has(key) || stop.has(key)) return;
    seen.add(key);
    tags.push(s);
  }
  for (const line of String(raw)
    .normalize('NFKC')
    .split(/[\r\n，。！？!?；;]+/))
    if (line.trim().length <= 24) add(line);
  for (const token of new Intl.Segmenter('zh-CN', { granularity: 'word' }).segment(text))
    if (token.isWordLike) add(token.segment);
  return { text, tags: tags.slice(0, 8) };
}
function restoreOcr(item, record, { mergeTags = true } = {}) {
  if (!record) return item;
  item.ocrStatus = record.status;
  item.ocrText = record.text || '';
  item.ocrTags = record.tags || [];
  if (mergeTags && record.status === 'done')
    item.tags = [...new Set([...(item.tags || []), ...(record.tags || [])])];
  return item;
}
class OcrQueue {
  constructor(
    lib,
    {
      engine,
      prepareImage,
      notify = () => {},
      intervalMs = 2000,
      startDelayMs = 10000,
      schedule = true,
      now = Date.now,
    },
  ) {
    Object.assign(this, {
      lib,
      engine,
      prepareImage,
      notify,
      intervalMs,
      startDelayMs,
      schedule,
      now,
    });
    this.running = false;
    this.stopped = false;
    this.error = '';
    this.phase = 'idle';
  }
  async init() {
    await this.lib.run(async () => {
      this.lib.data.settings ??= {};
      this.lib.data.settings.ocrEnabled ??= true;
      this.lib.data.ocrRecords ??= {};
      for (const [id, record] of Object.entries(this.lib.data.ocrRecords)) {
        if (record.status === 'processing') {
          record.status = 'interrupted';
          record.finishedAt = this.now();
          record.error = '上次识别中断，未自动重复执行。';
        }
        const item = this.lib.data.items.find((i) => i.id === id);
        if (item) restoreOcr(item, record, { mergeTags: false });
      }
      await this.lib.save();
    });
    if (this.schedule) this.arm(this.startDelayMs);
    return this;
  }
  summary() {
    let done = 0,
      failed = 0,
      pending = 0;
    for (const item of this.lib.data.items) {
      const record = this.lib.data.ocrRecords?.[item.id];
      if (!record) pending++;
      else if (record.status === 'done') done++;
      else if (record.status !== 'processing') failed++;
    }
    return {
      enabled: this.lib.data.settings?.ocrEnabled !== false,
      total: this.lib.data.items.length,
      done,
      failed,
      pending,
      running: this.running,
      phase: this.phase,
      error: this.error,
    };
  }
  arm(delay = this.intervalMs) {
    if (this.stopped || !this.schedule || this.lib.data.settings?.ocrEnabled === false) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.runOne()
        .catch((e) => {
          this.error = e.message;
          this.phase = 'error';
          this.notify(this.summary());
        })
        .finally(() => {
          if (!this.error) this.arm();
        });
    }, delay);
    this.timer.unref?.();
  }
  async setEnabled(enabled) {
    if (typeof enabled !== 'boolean') throw Error('无效的 OCR 设置');
    await this.lib.run(async () => {
      this.lib.data.settings ??= {};
      this.lib.data.settings.ocrEnabled = enabled;
      this.lib.data.settingsUpdatedAt ??= {};
      this.lib.data.settingsUpdatedAt.ocrEnabled = Date.now();
      await this.lib.save();
    });
    if (enabled) {
      this.error = '';
      if (!this.running) {
        this.phase = 'idle';
        this.arm(1000);
      }
    } else {
      clearTimeout(this.timer);
      if (!this.running) {
        this.phase = 'paused';
        this.engine.stop?.();
      }
    }
    this.notify(this.summary());
    return this.summary();
  }
  async runOne() {
    if (this.stopped || this.running || this.lib.data.settings?.ocrEnabled === false || this.error)
      return false;
    if (!this.lib.data.items.some((i) => !this.lib.data.ocrRecords?.[i.id])) {
      this.phase = 'idle';
      this.engine.stop?.();
      return false;
    }
    this.running = true;
    let job;
    try {
      this.phase = 'loading';
      this.notify(this.summary());
      try {
        await this.engine.prepare();
      } catch (e) {
        this.error = 'OCR 引擎未就绪：' + e.message;
        this.phase = 'error';
        return false;
      }
      if (this.stopped || this.lib.data.settings.ocrEnabled === false) return false;
      job = await this.lib.run(async () => {
        const item = this.lib.data.items.find((i) => !this.lib.data.ocrRecords[i.id]);
        if (!item) return null;
        this.lib.data.ocrRecords[item.id] = { status: 'processing', startedAt: this.now() };
        item.ocrStatus = 'processing';
        await this.lib.save();
        return { id: item.id, file: path.join(this.lib.root, 'originals', item.file) };
      });
      if (!job) return false;
      this.phase = 'recognizing';
      this.notify(this.summary());
      let record;
      try {
        const image = await this.prepareImage(job.file);
        const result = await this.engine.recognize(image);
        const parsed = tagsFromText(result.text, result.confidence ?? 100);
        record = {
          ...parsed,
          status: 'done',
          confidence: result.confidence ?? null,
          finishedAt: this.now(),
        };
      } catch (e) {
        record = {
          status: 'error',
          text: '',
          tags: [],
          error: String(e.message || e).slice(0, 300),
          finishedAt: this.now(),
        };
        if (this.engine.healthy === false) {
          this.error = 'OCR 进程已停止，可点击继续处理剩余图片。';
        }
      }
      let updated;
      await this.lib.run(async () => {
        const prior = this.lib.data.ocrRecords[job.id];
        this.lib.data.ocrRecords[job.id] = { ...prior, ...record };
        updated = this.lib.data.items.find((i) => i.id === job.id);
        if (updated) restoreOcr(updated, record);
        await this.lib.save();
      });
      this.notify(this.summary(), updated);
      return true;
    } finally {
      this.running = false;
      if (!this.error)
        this.phase = this.lib.data.settings?.ocrEnabled === false ? 'paused' : 'idle';
      if (this.lib.data.settings?.ocrEnabled === false) this.engine.stop?.();
      this.notify(this.summary());
    }
  }
  stop() {
    this.stopped = true;
    clearTimeout(this.timer);
    this.engine.stop?.();
  }
}
module.exports = { OcrQueue, tagsFromText, restoreOcr };
