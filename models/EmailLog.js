const mongoose = require('mongoose');

/**
 * EmailLog Model
 *
 * Tracks all email sending attempts for auditing and debugging
 * - Logs email sending status (pending, sent, failed)
 * - Prevents logging raw OTPs for security
 * - Auto-cleanup after 30 days
 */
const emailLogSchema = new mongoose.Schema({
  email: {
    type: String,
    required: true,
    trim: true,
    lowercase: true,
    index: true
  },
  type: {
    type: String,
    required: true,
    enum: [
      'email_verification_otp',
      'login_mfa_otp',
      'manual_test',
      'system_notification',
      'password_reset_otp',
      'submission_successful',
      'submission_promoted',
      'submission_eliminated',
      'evaluation_reminder',
      'evaluation_pending',
      'judge_assigned',
      'admin_notification',
      'system_critical',
      'password_reset', // Future use
      'welcome_email'   // Future use
    ]
  },
  subject: {
    type: String,
    required: true,
    trim: true
  },
  status: {
    type: String,
    required: true,
    enum: ['pending', 'sent', 'failed'],
    default: 'pending',
    index: true
  },
  // Error details (only populated on failure)
  error: {
    type: String,
    trim: true,
    default: null
  },
  // SMTP response details
  smtpResponse: {
    type: String,
    trim: true,
    default: null
  },
  // Reference to related entities (notification, user, etc.)
  referenceId: {
    type: mongoose.Schema.Types.ObjectId,
    default: null
  },
  referenceType: {
    type: String,
    enum: ['notification', 'user', 'otp'],
    default: null
  },
  // Metadata for additional context
  metadata: {
    type: mongoose.Schema.Types.Mixed,
    default: {}
  }
}, {
  timestamps: true
});

// Auto-delete logs after 30 days
emailLogSchema.index({ createdAt: 1 }, { expireAfterSeconds: 30 * 24 * 60 * 60 });

// Indexes for efficient queries
emailLogSchema.index({ email: 1, status: 1, createdAt: -1 });
emailLogSchema.index({ type: 1, status: 1, createdAt: -1 });
emailLogSchema.index({ referenceId: 1, referenceType: 1 });

// Static method to create email log
emailLogSchema.statics.logEmail = async function(data) {
  try {
    const log = await this.create(data);
    return log;
  } catch (error) {
    // Non-blocking - don't fail the main operation
      // Silently fail - don't log errors about logging
    return null;
  }
};

// Static method to update email status
emailLogSchema.statics.updateStatus = async function(id, status, error = null, smtpResponse = null) {
  try {
    const updateData = { status };
    if (error) updateData.error = error;
    if (smtpResponse) updateData.smtpResponse = smtpResponse;

    await this.findByIdAndUpdate(id, updateData);
  } catch (err) {
      // Silently fail - don't log errors about logging
  }
};

module.exports = mongoose.model('EmailLog', emailLogSchema);
