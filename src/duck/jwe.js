/**
 * duck.ai / DuckDuckGo Sync compatible compact JWE (A256GCM, `dir`).
 *
 * Reverse-engineered from the duck.ai web bundle (module 2113909, 2026-11-01):
 *
 *   protected = base64url(JSON.stringify({ alg:"dir", enc:"A256GCM", kid:"streams" }))
 *   ct        = AES-256-GCM(key, iv=12 random bytes, AAD=protected)
 *   compact   = `${protected}..${base64url(iv)}.${base64url(ct)}.${base64url(tag)}`
 *
 * The second segment (`encrypted_key`) is empty because `alg:"dir"` means the content
 * encryption key *is* the shared key (the DuckDuckGo Sync `mainKey`).
 *
 * Used for `identity.sync.encryptedPrivateKey` (durable-stream RSA private key wrapped by mainKey).
 */
import crypto from 'node:crypto';

/** Default protected header used by DuckDuckGo Sync for stream keys. */
export const JWE_PROTECTED_HEADER = Object.freeze({ alg: 'dir', enc: 'A256GCM', kid: 'streams' });

/** @param {Buffer|Uint8Array} buffer */
export function base64urlEncode(buffer) {
  return Buffer.from(buffer).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

/**
 * @param {string} value
 * @returns {Buffer}
 */
export function base64urlDecode(value) {
  const text = String(value || '').trim();
  if (!text) return Buffer.alloc(0);
  if (!/^[A-Za-z0-9_-]+$/.test(text)) {
    const error = new Error('value is not valid base64url');
    error.code = 'bad_base64';
    throw error;
  }
  const padded = text.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (text.length % 4)) % 4);
  return Buffer.from(padded, 'base64');
}

/** Securely random 32-byte AES-256 key. */
export function generateKey32() {
  return crypto.randomBytes(32);
}

/**
 * Encrypt bytes/string as compact JWE.
 * @param {Buffer|Uint8Array|string} plaintext
 * @param {Buffer|Uint8Array} key32 32-byte shared key (`dir`)
 * @param {{ kid?: string, iv?: Buffer|Uint8Array, protectedHeader?: Record<string, any> }} [options]
 * @returns {string} compact JWE (5 segments)
 */
export function encryptJwe(plaintext, key32, options = {}) {
  const key = Buffer.from(key32);
  if (key.length !== 32) {
    const error = new Error(`JWE dir key must be 32 bytes (got ${key.length})`);
    error.code = 'bad_key';
    throw error;
  }
  const header = {
    alg: 'dir',
    enc: 'A256GCM',
    kid: options.kid || JWE_PROTECTED_HEADER.kid,
    ...(options.protectedHeader || {})
  };
  const protectedB64 = base64urlEncode(Buffer.from(JSON.stringify(header), 'utf8'));
  const iv = options.iv ? Buffer.from(options.iv) : crypto.randomBytes(12);
  const data = typeof plaintext === 'string' ? Buffer.from(plaintext, 'utf8') : Buffer.from(plaintext);

  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(protectedB64, 'utf8'));
  const ciphertext = Buffer.concat([cipher.update(data), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [protectedB64, '', base64urlEncode(iv), base64urlEncode(ciphertext), base64urlEncode(tag)].join('.');
}

/**
 * Decrypt a compact JWE produced by `encryptJwe` / DuckDuckGo Sync.
 * @param {string} compact
 * @param {Buffer|Uint8Array} key32
 * @param {{ kid?: string | null }} [options]
 * @returns {Buffer}
 */
export function decryptJwe(compact, key32, options = {}) {
  const key = Buffer.from(key32);
  if (key.length !== 32) {
    const error = new Error(`JWE dir key must be 32 bytes (got ${key.length})`);
    error.code = 'bad_key';
    throw error;
  }
  const parts = String(compact || '').split('.');
  if (parts.length !== 5) {
    const error = new Error('JWE compact form must have 5 segments');
    error.code = 'bad_payload';
    throw error;
  }
  const [protectedB64, , ivB64, ciphertextB64, tagB64] = parts;

  let header;
  try {
    header = JSON.parse(base64urlDecode(protectedB64).toString('utf8'));
  } catch (error) {
    const wrapped = new Error('JWE protected header is not valid JSON');
    wrapped.code = 'bad_json';
    wrapped.cause = error;
    throw wrapped;
  }
  if (header.alg !== 'dir') {
    const error = new Error(`unsupported JWE alg "${header.alg}"`);
    error.code = 'ERR_JWE_UNSUPPORTED_ALG';
    throw error;
  }
  if (header.enc !== 'A256GCM') {
    const error = new Error(`unsupported JWE enc "${header.enc}"`);
    error.code = 'ERR_JWE_UNSUPPORTED_ENC';
    throw error;
  }
  if (options.kid && header.kid !== options.kid) {
    const error = new Error(`JWE kid mismatch (expected ${options.kid}, got ${header.kid})`);
    error.code = 'ERR_JWE_KID_MISMATCH';
    throw error;
  }

  const iv = base64urlDecode(ivB64);
  const ciphertext = base64urlDecode(ciphertextB64);
  const tag = base64urlDecode(tagB64);
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAAD(Buffer.from(protectedB64, 'utf8'));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch (error) {
    const wrapped = new Error('JWE decryption failed (wrong key or tampered ciphertext)');
    wrapped.code = 'decrypt_failed';
    wrapped.cause = error;
    throw wrapped;
  }
}

/** Decrypt a compact JWE to a UTF-8 string. */
export function decryptJweToString(compact, key32, options = {}) {
  return decryptJwe(compact, key32, options).toString('utf8');
}

/** Read the `kid` from a compact JWE header without decrypting (matches duck.ai behavior). */
export function jweKid(compact) {
  try {
    const header = JSON.parse(base64urlDecode(String(compact).split('.')[0]).toString('utf8'));
    return typeof header.kid === 'string' ? header.kid : null;
  } catch {
    return null;
  }
}

export default { encryptJwe, decryptJwe, decryptJweToString, generateKey32, base64urlEncode, base64urlDecode, jweKid, JWE_PROTECTED_HEADER };
