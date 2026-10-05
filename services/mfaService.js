const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const mongoose = require('mongoose');
const MfaChallenge = require('../models/MfaChallenge');
const User = require('../models/User');
const emailService = require('./emailService');

const MFA_EXPIRY_MS = 10 * 60 * 1000;
const MFA_RESEND_COOLDOWN_MS = 60 * 1000;
const MFA_MAX_ATTEMPTS = 5;
const MFA_MAX_RESENDS = 5;
const PRIVILEGED_ROLES = new Set(['admin', 'superadmin']);

function maskEmail(email) {
  const [localPart = '', domain = ''] = String(email || '').split('@');
  if (!domain) return 'your registered email';
  const visible = localPart.slice(0, Math.min(2, localPart.length));
  return `${visible}${'*'.repeat(Math.max(3, localPart.length - visible.length))}@${domain}`;
}

class MfaService {
  static generateOTP() {
    return crypto.randomInt(100000, 1000000).toString();
  }

  static async createChallenge(user, context = {}) {
    if (!user || !PRIVILEGED_ROLES.has(user.role)) {
      return { success: false, error: 'MFA is not available for this account' };
    }

    await MfaChallenge.deleteMany({ userId: user._id });

    const otp = this.generateOTP();
    const otpHash = await bcrypt.hash(otp, 12);
    const now = new Date();
    const challenge = await MfaChallenge.create({
      userId: user._id,
      otpHash,
      expiresAt: new Date(now.getTime() + MFA_EXPIRY_MS),
      attempts: 0,
      resendCount: 0,
      lastSentAt: now,
      requestedIp: context.ip || null,
      userAgent: context.userAgent || null
    });

    const sent = await emailService.sendMFAOTP(user.email, otp, user.name);
    if (!sent) {
      await MfaChallenge.deleteOne({ _id: challenge._id });
      return { success: false, error: 'Unable to send the authentication code' };
    }

    return {
      success: true,
      challengeId: challenge._id.toString(),
      maskedEmail: maskEmail(user.email),
      expiresInSeconds: Math.floor(MFA_EXPIRY_MS / 1000)
    };
  }

  static async verifyChallenge(challengeId, otp) {
    if (!mongoose.isValidObjectId(challengeId) || !/^\d{6}$/.test(String(otp || ''))) {
      return { success: false, error: 'Invalid or expired authentication code' };
    }

    const challenge = await MfaChallenge.findOne({
      _id: challengeId,
      expiresAt: { $gt: new Date() }
    });

    if (!challenge) {
      return { success: false, error: 'Invalid or expired authentication code' };
    }

    if (challenge.attempts >= MFA_MAX_ATTEMPTS) {
      await MfaChallenge.deleteOne({ _id: challenge._id });
      return { success: false, error: 'Too many attempts. Please sign in again.' };
    }

    challenge.attempts += 1;
    await challenge.save();

    const isValid = await bcrypt.compare(String(otp), challenge.otpHash);
    if (!isValid) {
      if (challenge.attempts >= MFA_MAX_ATTEMPTS) {
        await MfaChallenge.deleteOne({ _id: challenge._id });
        return { success: false, error: 'Too many attempts. Please sign in again.' };
      }
      return { success: false, error: 'Invalid or expired authentication code' };
    }

    const consumed = await MfaChallenge.deleteOne({
      _id: challenge._id,
      otpHash: challenge.otpHash
    });
    if (consumed.deletedCount !== 1) {
      return { success: false, error: 'Invalid or expired authentication code' };
    }

    const user = await User.findOne({
      _id: challenge.userId,
      status: 'active',
      isDeleted: { $ne: true },
      role: { $in: Array.from(PRIVILEGED_ROLES) }
    });

    if (!user) {
      return { success: false, error: 'Account is not available' };
    }

    if (!user.emailVerified) {
      user.emailVerified = true;
      await user.save();
    }

    return { success: true, user };
  }

  static async resendChallenge(challengeId) {
    if (!mongoose.isValidObjectId(challengeId)) {
      return { success: false, error: 'Invalid or expired MFA challenge' };
    }

    const challenge = await MfaChallenge.findOne({
      _id: challengeId,
      expiresAt: { $gt: new Date() }
    });

    if (!challenge) {
      return { success: false, error: 'Invalid or expired MFA challenge' };
    }

    const elapsed = Date.now() - challenge.lastSentAt.getTime();
    if (elapsed < MFA_RESEND_COOLDOWN_MS) {
      return {
        success: false,
        error: `Please wait ${Math.ceil((MFA_RESEND_COOLDOWN_MS - elapsed) / 1000)} seconds before requesting another code`
      };
    }

    if (challenge.resendCount >= MFA_MAX_RESENDS) {
      await MfaChallenge.deleteOne({ _id: challenge._id });
      return { success: false, error: 'Too many resend requests. Please sign in again.' };
    }

    const user = await User.findOne({
      _id: challenge.userId,
      status: 'active',
      isDeleted: { $ne: true },
      role: { $in: Array.from(PRIVILEGED_ROLES) }
    });

    if (!user) {
      await MfaChallenge.deleteOne({ _id: challenge._id });
      return { success: false, error: 'Account is not available' };
    }

    const otp = this.generateOTP();
    const sent = await emailService.sendMFAOTP(user.email, otp, user.name);
    if (!sent) {
      return { success: false, error: 'Unable to send the authentication code' };
    }

    challenge.otpHash = await bcrypt.hash(otp, 12);
    challenge.expiresAt = new Date(Date.now() + MFA_EXPIRY_MS);
    challenge.attempts = 0;
    challenge.resendCount += 1;
    challenge.lastSentAt = new Date();
    await challenge.save();

    return {
      success: true,
      challengeId: challenge._id.toString(),
      maskedEmail: maskEmail(user.email),
      expiresInSeconds: Math.floor(MFA_EXPIRY_MS / 1000)
    };
  }
}

module.exports = MfaService;
