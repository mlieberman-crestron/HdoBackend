const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const TOKEN_FILE = path.join(__dirname, '..', '.schwab-tokens');
const ALGORITHM = 'aes-256-gcm';

function getKey() {
  const hex = process.env.TOKEN_ENCRYPTION_KEY;
  if (!hex || hex.length !== 64) {
    throw new Error('TOKEN_ENCRYPTION_KEY must be a 64-character hex string in .env');
  }
  return Buffer.from(hex, 'hex');
}

function encrypt(data) {
  const key = getKey();
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(data), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('hex')}:${tag.toString('hex')}:${encrypted.toString('hex')}`;
}

function decrypt(raw) {
  const key = getKey();
  const [ivHex, tagHex, dataHex] = raw.split(':');
  const decipher = crypto.createDecipheriv(ALGORITHM, key, Buffer.from(ivHex, 'hex'));
  decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
  const decrypted = Buffer.concat([decipher.update(Buffer.from(dataHex, 'hex')), decipher.final()]);
  return JSON.parse(decrypted.toString('utf8'));
}

function saveTokens(tokens) {
  fs.writeFileSync(TOKEN_FILE, encrypt(tokens), 'utf8');
  // Restrict file to owner read/write only (no effect on Windows but good practice)
  try { fs.chmodSync(TOKEN_FILE, 0o600); } catch {}
}

function loadTokens() {
  if (!fs.existsSync(TOKEN_FILE)) return null;
  try {
    return decrypt(fs.readFileSync(TOKEN_FILE, 'utf8'));
  } catch {
    console.warn('[tokenStore] Failed to decrypt token file — re-authentication required');
    return null;
  }
}

module.exports = { saveTokens, loadTokens };
