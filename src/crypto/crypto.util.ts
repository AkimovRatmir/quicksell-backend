import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from 'node:crypto';

/* ---------- App-user passwords: one-way scrypt hash ---------- */

const SCRYPT_KEYLEN = 64;

/** `scrypt$<saltHex>$<hashHex>` — salt is per-password. */
export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, SCRYPT_KEYLEN);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [scheme, saltHex, hashHex] = stored.split('$');
  if (scheme !== 'scrypt' || !saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = scryptSync(
    password,
    Buffer.from(saltHex, 'hex'),
    expected.length,
  );
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

/* ---------- Single-use secrets: password-reset tokens ---------- */

/** 32 bytes of entropy, URL-safe — goes in the reset link, never stored raw. */
export function generateToken(): string {
  return randomBytes(32).toString('base64url');
}

/**
 * What we store for a reset token. Plain SHA-256 (no salt, no stretching) is
 * right here and wrong for passwords: the token is already 256 random bits, so
 * there is nothing to brute-force, and the lookup has to be a plain indexed
 * equality check. Storing it means a database leak cannot be used to reset
 * anyone's password.
 */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/* ---------- Kaspi credentials: reversible AES-256-GCM ---------- */

/**
 * Derives the 32-byte AES key from CREDENTIALS_ENC_KEY. Accepts a base64 or
 * hex 32-byte key, or any passphrase (scrypt-stretched as a fallback).
 */
function encKey(): Buffer {
  const raw = process.env.CREDENTIALS_ENC_KEY;
  if (!raw) {
    throw new Error('CREDENTIALS_ENC_KEY is not set — cannot encrypt secrets');
  }
  for (const enc of ['base64', 'hex'] as const) {
    try {
      const b = Buffer.from(raw, enc);
      if (b.length === 32) return b;
    } catch {
      /* try next */
    }
  }
  return scryptSync(raw, 'quickAnalytics.creds.v1', 32);
}

/** Returns `gcm$<ivHex>$<tagHex>$<cipherHex>`. */
export function encryptSecret(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encKey(), iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `gcm$${iv.toString('hex')}$${tag.toString('hex')}$${ct.toString('hex')}`;
}

export function decryptSecret(blob: string): string {
  const [scheme, ivHex, tagHex, ctHex] = blob.split('$');
  if (scheme !== 'gcm' || !ivHex || !tagHex || !ctHex) {
    throw new Error('Malformed encrypted secret');
  }
  const decipher = createDecipheriv(
    'aes-256-gcm',
    encKey(),
    Buffer.from(ivHex, 'hex'),
  );
  decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
  return Buffer.concat([
    decipher.update(Buffer.from(ctHex, 'hex')),
    decipher.final(),
  ]).toString('utf8');
}
