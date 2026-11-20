const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const reasons = {
  added: '已加入素材库',
  restored: '已从回收站恢复',
  duplicate: '相同内容已存在',
  in_trash: '已在回收站，自动收集未恢复',
  unsupported: '无法识别的图片格式',
  too_large: '文件超过 100 MB 限制',
  empty: '文件为空',
  permission: '没有读取权限',
  missing: '文件或目录不存在',
  depth: '目录层级超过 12 层',
  symlink: '跳过符号链接，避免循环读取',
  hidden: '隐藏文件或目录',
  read_error: '读取失败',
};
function reasonFor(error) {
  return ['EACCES', 'EPERM'].includes(error?.code)
    ? 'permission'
    : error?.code === 'ENOENT'
      ? 'missing'
      : 'read_error';
}
class ImportReport {
  constructor(source) {
    this.id = crypto.randomUUID();
    this.createdAt = Date.now();
    this.source = source;
    this.details = [];
    this.counts = { added: 0, restored: 0, duplicate: 0, skipped: 0, failed: 0 };
    this.reasons = {};
    this.omitted = 0;
  }
  add(file, status, code, error) {
    this.counts[status] = (this.counts[status] || 0) + 1;
    this.reasons[code] = (this.reasons[code] || 0) + 1;
    const detail = {
      key: String(this.details.length),
      path: file,
      name: path.basename(file) || file,
      status,
      code,
      message: reasons[code] || '未完成',
      error: error ? String(error.message || error).slice(0, 300) : undefined,
    };
    if (this.details.length < 20000) this.details.push(detail);
    else {
      this.omitted++;
      if (['failed', 'skipped'].includes(status)) {
        this.replaceIndex ??= this.details.length - 1;
        while (
          this.replaceIndex >= 0 &&
          ['failed', 'skipped'].includes(this.details[this.replaceIndex].status)
        )
          this.replaceIndex--;
        if (this.replaceIndex >= 0) {
          detail.key = String(this.replaceIndex);
          this.details[this.replaceIndex--] = detail;
        }
      }
    }
  }
  summary() {
    return {
      id: this.id,
      createdAt: this.createdAt,
      source: this.source,
      counts: this.counts,
      reasons: this.reasons,
      detailsCount: this.details.length,
      omitted: this.omitted,
    };
  }
  async persist(lib, { automatic = false } = {}) {
    if (automatic && !this.counts.added && !this.counts.restored && !this.counts.failed)
      return null;
    const summaries = lib.data.importReports || [];
    const signature = crypto
      .createHash('sha256')
      .update(
        JSON.stringify({
          source: this.source,
          counts: this.counts,
          reasons: this.reasons,
          issues: this.details
            .filter((item) => item.status === 'failed')
            .map((item) => [item.path, item.code, item.error]),
        }),
      )
      .digest('hex');
    if (
      automatic &&
      !this.counts.added &&
      !this.counts.restored &&
      summaries[0]?.signature === signature &&
      this.createdAt - summaries[0].createdAt < 300000
    )
      return summaries[0].id;
    const directory = path.join(lib.root, 'reports');
    await fs.mkdir(directory, { recursive: true });
    const file = path.join(directory, this.id + '.json');
    await fs.writeFile(
      file + '.tmp',
      JSON.stringify({ ...this.summary(), details: this.details }),
      { mode: 0o600 },
    );
    await fs.rename(file + '.tmp', file);
    const next = [{ ...this.summary(), signature }, ...summaries];
    lib.data.importReports = next.slice(0, 20);
    for (const old of next.slice(20))
      await fs.unlink(path.join(directory, old.id + '.json')).catch(() => {});
    return this.id;
  }
}
async function readReport(lib, id) {
  if (!/^[a-f0-9-]{36}$/.test(id)) throw Error('诊断记录无效');
  let value;
  try {
    value = JSON.parse(await fs.readFile(path.join(lib.root, 'reports', id + '.json'), 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') throw Error('该诊断记录已过期，请选择最近的一条记录。');
    throw Error('无法读取诊断记录，请重新导入后查看。');
  }
  return value;
}
module.exports = { ImportReport, readReport, reasonFor, reasons };
