const mongoose = require('mongoose');

const mfaChallengeSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true
  },
  otpHash: {
    type: String,
    required: true
  },
  expiresAt: {
    type: Date,
    required: true,
    index: { expires: 0 }
  },
  attempts: {
    type: Number,
    default: 0,
    max: 5
  },
  resendCount: {
    type: Number,
    default: 0,
    max: 5
  },
  lastSentAt: {
    type: Date,
    required: true
  },
  requestedIp: {
    type: String,
    default: null
  },
  userAgent: {
    type: String,
    default: null
  }
}, {
  timestamps: true
});

mfaChallengeSchema.index({ userId: 1, expiresAt: -1 });

module.exports = mongoose.model('MfaChallenge', mfaChallengeSchema);
