/**
 * v2.2 JWE（A256GCM / dir）工具测试（src/duck/jwe.js）。
 *
 * 断言：32 字节 key、compact 5 段、encrypted_key 为空（dir）、protected 含 alg/enc/kid、
 * round-trip 还原明文、错误 key 解密失败。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  generateKey32,
  base64urlEncode,
  base64urlDecode,
  encryptJwe,
  decryptJwe,
  JWE_PROTECTED_HEADER
} from '../src/duck/jwe.js';

test('generateKey32 / base64url 编解码', () => {
  const key = generateKey32();
  const buffer = Buffer.from(key);
  assert.equal(buffer.length, 32);
  // 两次生成不同
  assert.notEqual(Buffer.from(generateKey32()).toString('hex'), buffer.toString('hex'));

  const text = 'hello 世界';
  const encoded = base64urlEncode(Buffer.from(text, 'utf8'));
  assert.match(encoded, /^[A-Za-z0-9_-]+$/);
  assert.equal(Buffer.from(base64urlDecode(encoded)).toString('utf8'), text);
});

test('encryptJwe：compact 5 段，protected=dir/A256GCM/kid=streams，encrypted_key 为空', () => {
  const key = Buffer.from(generateKey32());
  const plaintext = Buffer.from('{"kty":"RSA","d":"private"}', 'utf8');
  const compact = encryptJwe(plaintext, key, {});
  assert.equal(typeof compact, 'string');

  const parts = compact.split('.');
  assert.equal(parts.length, 5, 'JWE compact must have 5 segments');
  const [protectedHeader, encryptedKey, iv, ciphertext, tag] = parts;
  assert.equal(encryptedKey, '', 'alg=dir must have empty encrypted_key');
  assert.ok(iv.length > 0 && ciphertext.length > 0 && tag.length > 0);

  const header = JSON.parse(Buffer.from(base64urlDecode(protectedHeader)).toString('utf8'));
  assert.equal(header.alg, 'dir');
  assert.equal(header.enc, 'A256GCM');
  assert.equal(header.kid, 'streams');
  assert.ok(JWE_PROTECTED_HEADER, 'JWE_PROTECTED_HEADER should be exported');
});

test('encryptJwe → decryptJwe round-trip；错误 key 抛错', () => {
  const key = Buffer.from(generateKey32());
  const plaintext = Buffer.from('secret-private-key-material', 'utf8');
  const compact = encryptJwe(plaintext, key, {});
  const decrypted = decryptJwe(compact, key);
  assert.equal(Buffer.from(decrypted).toString('utf8'), plaintext.toString('utf8'));

  const wrongKey = Buffer.from(generateKey32());
  assert.throws(() => decryptJwe(compact, wrongKey));
});

test('encryptJwe 可加密真实 RSA 私钥 JWK 大对象', async () => {
  const crypto = await import('node:crypto');
  const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const privateJwk = privateKey.export({ format: 'jwk' });
  const key = Buffer.from(generateKey32());
  const compact = encryptJwe(Buffer.from(JSON.stringify(privateJwk), 'utf8'), key, { kid: 'streams' });
  const roundTrip = JSON.parse(Buffer.from(decryptJwe(compact, key)).toString('utf8'));
  assert.equal(roundTrip.kty, 'RSA');
  assert.equal(roundTrip.d, privateJwk.d);
  assert.equal(roundTrip.n, privateJwk.n);
});
