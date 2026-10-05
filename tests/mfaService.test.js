const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');

const challengePath = require.resolve('../models/MfaChallenge');
const userPath = require.resolve('../models/User');
const emailServicePath = require.resolve('../services/emailService');
const mfaServicePath = require.resolve('../services/mfaService');

const challenges = new Map();
let deliveredOTP = null;
let privilegedUser = null;

const challengeModel = {
  async deleteMany() {
    challenges.clear();
  },
  async create(data) {
    const challenge = {
      ...data,
      _id: new mongoose.Types.ObjectId(),
      async save() {
        challenges.set(this._id.toString(), this);
      }
    };
    challenges.set(challenge._id.toString(), challenge);
    return challenge;
  },
  async findOne(query) {
    const challenge = challenges.get(String(query._id));
    if (!challenge || challenge.expiresAt <= query.expiresAt.$gt) return null;
    return challenge;
  },
  async deleteOne(query) {
    const challenge = challenges.get(String(query._id));
    if (!challenge || (query.otpHash && query.otpHash !== challenge.otpHash)) {
      return { deletedCount: 0 };
    }
    challenges.delete(String(query._id));
    return { deletedCount: 1 };
  }
};

const userModel = {
  async findOne(query) {
    return privilegedUser && String(query._id) === String(privilegedUser._id)
      ? privilegedUser
      : null;
  }
};

const emailService = {
  async sendMFAOTP(email, otp) {
    assert.equal(email, privilegedUser.email);
    deliveredOTP = otp;
    return true;
  }
};

require.cache[challengePath] = { id: challengePath, filename: challengePath, loaded: true, exports: challengeModel };
require.cache[userPath] = { id: userPath, filename: userPath, loaded: true, exports: userModel };
require.cache[emailServicePath] = { id: emailServicePath, filename: emailServicePath, loaded: true, exports: emailService };
delete require.cache[mfaServicePath];

const MfaService = require('../services/mfaService');

test('admin MFA challenge is delivered, single-use, and rejects replay', async () => {
  privilegedUser = {
    _id: new mongoose.Types.ObjectId(),
    role: 'admin',
    email: 'admin@example.com',
    name: 'Admin User',
    emailVerified: true,
    async save() {}
  };

  const created = await MfaService.createChallenge(privilegedUser, {
    ip: '127.0.0.1',
    userAgent: 'node-test'
  });

  assert.equal(created.success, true);
  assert.match(created.challengeId, /^[a-f\d]{24}$/);
  assert.match(deliveredOTP, /^\d{6}$/);
  assert.equal(created.maskedEmail, 'ad***@example.com');

  const invalid = await MfaService.verifyChallenge(created.challengeId, '000000');
  assert.equal(invalid.success, false);

  const verified = await MfaService.verifyChallenge(created.challengeId, deliveredOTP);
  assert.equal(verified.success, true);
  assert.equal(verified.user, privilegedUser);

  const replay = await MfaService.verifyChallenge(created.challengeId, deliveredOTP);
  assert.equal(replay.success, false);
});

test('MFA challenges are unavailable to non-privileged roles', async () => {
  const result = await MfaService.createChallenge({ role: 'teacher' });
  assert.deepEqual(result, {
    success: false,
    error: 'MFA is not available for this account'
  });
});
