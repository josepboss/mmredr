/* Standard Base32 / SHA-1 TOTP, computed entirely with browser Web Crypto. */
(function (root) {
  'use strict';
  function decodeSecret(input) {
    const secret = input.replace(/[\s-]/g, '').toUpperCase();
    if (!/^[A-Z2-7]+={0,6}$/.test(secret)) {
      throw new Error('Enter a valid Base32 secret (letters A–Z and numbers 2–7).');
    }
    const raw = secret.replace(/=+$/, '');
    if (![0, 2, 4, 5, 7].includes(raw.length % 8)) {
      throw new Error('This secret has an invalid length. Check that you copied the complete key.');
    }
    const bytes = [];
    let bits = 0, value = 0;
    for (const character of raw) {
      value = (value << 5) | 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'.indexOf(character);
      bits += 5;
      if (bits >= 8) {
        bits -= 8;
        bytes.push((value >>> bits) & 255);
        value &= (1 << bits) - 1;
      }
    }
    if (value !== 0 || bytes.length === 0) throw new Error('This Base32 secret is incomplete or invalid.');
    return new Uint8Array(bytes);
  }

  async function importSecret(input) {
    if (!root.crypto?.subtle) throw new Error('Code generation requires HTTPS or localhost in a modern browser.');
    return root.crypto.subtle.importKey('raw', decodeSecret(input), { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']);
  }

  async function generateCode(key, timestamp = Date.now(), digits = 6) {
    if (![6, 8].includes(digits)) throw new Error('Unsupported code length.');
    const counter = BigInt(Math.floor(timestamp / 30000));
    const buffer = new ArrayBuffer(8);
    new DataView(buffer).setBigUint64(0, counter);
    const hash = new Uint8Array(await root.crypto.subtle.sign('HMAC', key, buffer));
    const offset = hash[hash.length - 1] & 15;
    const number = ((hash[offset] & 127) << 24) | (hash[offset + 1] << 16) | (hash[offset + 2] << 8) | hash[offset + 3];
    return String(number % (10 ** digits)).padStart(digits, '0');
  }
  root.MailReaderTOTP = { decodeSecret, importSecret, generateCode };
})(globalThis);
