const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');

const context = vm.createContext({ crypto: webcrypto });
vm.runInContext(fs.readFileSync(require('node:path').join(__dirname, '../public/totp.js'), 'utf8'), context);
const { decodeSecret, importSecret, generateCode } = context.MailReaderTOTP;
const secret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';

test('matches all RFC 6238 SHA-1 test vectors, including dates beyond 2038', async () => {
  const key = await importSecret(secret);
  const vectors = [[59, '94287082'], [1111111109, '07081804'], [1111111111, '14050471'], [1234567890, '89005924'], [2000000000, '69279037'], [20000000000, '65353130']];
  for (const [seconds, expected] of vectors) {
    assert.equal(await generateCode(key, seconds * 1000, 8), expected);
    assert.equal(await generateCode(key, seconds * 1000), expected.slice(-6));
  }
});

test('normalizes pasted lowercase, spaces, separators, and Base32 padding', () => {
  assert.deepEqual(Array.from(decodeSecret('mzxw-6=== ')), Array.from(decodeSecret('MZXW6')));
  assert.equal(Buffer.from(decodeSecret(secret)).toString(), '12345678901234567890');
});

test('rejects empty, malformed, and truncated secrets', () => {
  for (const input of ['', 'ABC1', 'ABC0', 'A', 'ABC', 'ABCDEF', 'MZ', 'MZXW6=ABC', '!!!!']) {
    assert.throws(() => decodeSecret(input), undefined, input);
  }
});

test('code is stable within its window and changes on the 30-second boundary', async () => {
  const key = await importSecret(secret);
  assert.equal(await generateCode(key, 59000), await generateCode(key, 59999));
  assert.notEqual(await generateCode(key, 59999), await generateCode(key, 60000));
  assert.match(await generateCode(key, 1111111109000), /^\d{6}$/);
});
