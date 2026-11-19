const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { identify } = require('./library.cjs');

// SQLCipher 4: page HMAC authenticates ciphertext + IV + little-endian page number.
function decryptDatabase(buffer, secret) {
  if (buffer.subarray(0, 16).toString() === 'SQLite format 3\0') return buffer;
  if (buffer.length < 4096 || buffer.length % 4096) throw Error('表情数据库分页格式不支持');
  const salt = buffer.subarray(0, 16);
  const macSalt = Buffer.from(salt.map((n) => n ^ 0x3a));
  const keys = [crypto.pbkdf2Sync(secret, salt, 256000, 32, 'sha512'), secret];
  for (const key of keys) {
    const macKey = crypto.pbkdf2Sync(key, macSalt, 2, 32, 'sha512');
    const output = Buffer.alloc(buffer.length);
    let valid = true;
    for (let start = 0, number = 1; start < buffer.length; start += 4096, number++) {
      const offset = start === 0 ? 16 : 0;
      const end = start + 4096;
      const ivStart = end - 80;
      const pageNumber = Buffer.alloc(4);
      pageNumber.writeUInt32LE(number);
      const expected = crypto
        .createHmac('sha512', macKey)
        .update(buffer.subarray(start + offset, ivStart + 16))
        .update(pageNumber)
        .digest();
      if (!crypto.timingSafeEqual(expected, buffer.subarray(ivStart + 16, end))) {
        valid = false;
        break;
      }
      const decoder = crypto.createDecipheriv(
        'aes-256-cbc',
        key,
        buffer.subarray(ivStart, ivStart + 16),
      );
      decoder.setAutoPadding(false);
      Buffer.concat([
        decoder.update(buffer.subarray(start + offset, ivStart)),
        decoder.final(),
      ]).copy(output, start + offset);
      buffer.copy(output, ivStart, ivStart, end);
    }
    if (valid) {
      output.write('SQLite format 3\0', 0, 'binary');
      return output;
    }
  }
  throw Error('表情数据库密钥不匹配或分页校验失败');
}
function decryptSticker(payload, key) {
  if (key.length !== 16 || payload.length % 16) return null;
  const decoder = crypto.createDecipheriv('aes-128-cbc', key, key);
  decoder.setAutoPadding(false);
  let bytes = Buffer.concat([decoder.update(payload), decoder.final()]);
  const pad = bytes[bytes.length - 1];
  if (pad > 0 && pad <= 16 && bytes.subarray(-pad).every((n) => n === pad))
    bytes = bytes.subarray(0, -pad);
  return identify(bytes) ? bytes : null;
}
async function recoverEncryptedCache({ home, account, dataRoot, cache }) {
  const unknown = [];
  for (const name of await fs.readdir(cache)) {
    if (!/^[a-f\d]{32}\.(jpg|gif|png|webp)$/i.test(name)) continue;
    const file = path.join(cache, name);
    const bytes = await fs.readFile(file);
    if (!identify(bytes))
      unknown.push({ file, name, bytes, id: path.parse(name).name.toLowerCase() });
  }
  if (!unknown.length) return { recovered: 0, unreadable: 0 };
  const keyFile = path.join(
    home,
    'Library/Containers/com.tencent.xinWeChat/Data/Documents/export-wechat-emoji',
    `emoticon_dbkey_${account}.txt`,
  );
  const keyText = (await fs.readFile(keyFile, 'utf8')).trim();
  if (!/^[a-f\d]{64}$/i.test(keyText)) throw Error('表情数据库密钥格式不支持');
  const dbPath = path.join(
    dataRoot ||
      path.join(home, 'Library/Containers/com.tencent.xinWeChat/Data/Documents/xwechat_files'),
    account,
    'db_storage/emoticon/emoticon.db',
  );
  const decoded = decryptDatabase(await fs.readFile(dbPath), Buffer.from(keyText, 'hex'));
  const scratch = await fs.mkdtemp(path.join(cache, '.metadata-'));
  let db;
  try {
    const temp = path.join(scratch, 'emoticon.sqlite');
    await fs.writeFile(temp, decoded, { mode: 0o600 });
    const { DatabaseSync } = require('node:sqlite');
    db = new DatabaseSync(temp, { readOnly: true });
    const keys = new Map();
    for (const row of db
      .prepare(
        'SELECT md5, aes_key, cdn_url, tp_url, thumb_url, extern_url, encrypt_url FROM kNonStoreEmoticonTable',
      )
      .all()) {
      const key = String(row.aes_key || '');
      keys.set(String(row.md5).toLowerCase(), key);
      for (const field of ['cdn_url', 'tp_url', 'thumb_url', 'extern_url', 'encrypt_url']) {
        try {
          const id = new URL(row[field]).searchParams.get('m');
          if (id) keys.set(id.toLowerCase(), key);
        } catch {}
      }
    }
    let recovered = 0;
    for (const item of unknown) {
      const aes = keys.get(item.id);
      if (!/^[a-f\d]{32}$/i.test(aes || '')) continue;
      const image = decryptSticker(item.bytes, Buffer.from(aes, 'hex'));
      if (!image) continue;
      const backup = path.join(cache, '.encrypted-backup');
      await fs.mkdir(backup, { recursive: true });
      await fs.writeFile(path.join(backup, item.name), item.bytes, { mode: 0o600 });
      await fs.writeFile(item.file, image);
      recovered++;
    }
    return { recovered, unreadable: unknown.length - recovered };
  } finally {
    db?.close();
    decoded.fill(0);
    await fs.rm(scratch, { recursive: true, force: true });
  }
}
module.exports = { decryptDatabase, decryptSticker, recoverEncryptedCache };
