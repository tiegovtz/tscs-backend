const test = require('node:test');
const assert = require('node:assert/strict');
const { validatePassword } = require('../utils/passwordPolicy');

test('password policy accepts a password satisfying every requirement', () => {
  assert.deepEqual(validatePassword('StrongPass1!'), { valid: true });
});

test('password policy rejects missing length, uppercase, and special characters', () => {
  assert.equal(validatePassword('Short1!').valid, false);
  assert.equal(validatePassword('lowercase1!').message, 'Password must contain at least one uppercase letter');
  assert.equal(validatePassword('StrongPass1').message, 'Password must contain at least one special character');
});
