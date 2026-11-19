const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { decryptDatabase, decryptSticker } = require('../src/wechat-crypto.cjs');
test('SQLCipher page is authenticated before decryption and rejects tampering', () => {
  const secret = Buffer.alloc(32, 7),
    salt = Buffer.alloc(16, 3),
    iv = Buffer.alloc(16, 9);
  const key = crypto.pbkdf2Sync(secret, salt, 256000, 32, 'sha512');
  const plain = Buffer.alloc(4000, 11),
    page = Buffer.alloc(4096);
  salt.copy(page);
  const encoder = crypto.createCipheriv('aes-256-cbc', key, iv);
  encoder.setAutoPadding(false);
  Buffer.concat([encoder.update(plain), encoder.final()]).copy(page, 16);
  iv.copy(page, 4016);
  const macKey = crypto.pbkdf2Sync(key, Buffer.from(salt.map((n) => n ^ 0x3a)), 2, 32, 'sha512');
  const num = Buffer.from([1, 0, 0, 0]);
  crypto
    .createHmac('sha512', macKey)
    .update(page.subarray(16, 4032))
    .update(num)
    .digest()
    .copy(page, 4032);
  const decoded = decryptDatabase(page, secret);
  assert.equal(decoded.subarray(0, 16).toString(), 'SQLite format 3\0');
  assert.deepEqual(decoded.subarray(16, 4016), plain);
  const corrupt = Buffer.from(page);
  corrupt[42] ^= 1;
  assert.throws(() => decryptDatabase(corrupt, secret), /校验失败/);
});
test('encrypted animated sticker recovers all frames without image re-encoding', () => {
  const frame = Buffer.from('21f904000a0000002c0000000001000100000202440100', 'hex');
  const gif = Buffer.concat([
    Buffer.from('47494638396101000100800000000000ffffff', 'hex'),
    frame,
    frame,
    Buffer.from([59]),
  ]);
  const key = Buffer.alloc(16, 5),
    cipher = crypto.createCipheriv('aes-128-cbc', key, key);
  const payload = Buffer.concat([cipher.update(gif), cipher.final()]);
  assert.deepEqual(decryptSticker(payload, key), gif);
  assert.equal(decryptSticker(payload, Buffer.alloc(16, 8)), null);
});
