const Notification = require('../models/Notification');
const emailService = require('./emailService');
const smsService = require('./smsService');
const User = require('../models/User');

/**
 * Notification Service
 *
 * Event-driven notification system
 * - Handles in-app notifications
 * - Manages email notifications
 * - Decouples notification logic from business logic
 */
class NotificationService {
  constructor() {
    this.eventHandlers = new Map();
    this.setupEventHandlers();
  }

  /**
   * Set up event handlers for different notification types
   */
  setupEventHandlers() {
    // User registration event
    this.on('USER_REGISTERED', this.handleUserRegistration.bind(this));

    // System notification event
    this.on('SYSTEM_NOTIFICATION', this.handleSystemNotification.bind(this));

    // Competition events
    this.on('COMPETITION_ROUND_STARTED', this.handleCompetitionRoundStarted.bind(this));
    this.on('COMPETITION_ROUND_ENDING_SOON', this.handleCompetitionRoundEndingSoon.bind(this));
    this.on('COMPETITION_ROUND_ENDED', this.handleCompetitionRoundEnded.bind(this));

    // Submission events (Email enabled for teachers)
    this.on('SUBMISSION_SUCCESSFUL', this.handleSubmissionSuccessful.bind(this));
    this.on('SUBMISSION_PROMOTED', this.handleSubmissionPromoted.bind(this));
    this.on('SUBMISSION_ELIMINATED', this.handleSubmissionEliminated.bind(this));
    this.on('SUBMISSION_DISQUALIFIED', this.handleSubmissionDisqualified.bind(this));

    // Evaluation events (Email enabled for judges)
    this.on('EVALUATION_REMINDER', this.handleEvaluationReminder.bind(this));
    this.on('EVALUATION_PENDING', this.handleEvaluationPending.bind(this));
    this.on('JUDGE_ASSIGNED', this.handleJudgeAssigned.bind(this));

    // Admin notification events (Email enabled)
    this.on('ADMIN_NOTIFICATION', this.handleAdminNotification.bind(this));

    // System critical events (Email enabled for admins)
    this.on('SYSTEM_CRITICAL', this.handleSystemCritical.bind(this));
  }

  /**
   * Register event handler
   * @param {string} event - Event name
   * @param {Function} handler - Event handler function
   */
  on(event, handler) {
    this.eventHandlers.set(event, handler);
  }

  /**
   * Emit event with data
   * @param {string} event - Event name
   * @param {Object} data - Event data
   */
  async emit(event, data) {
    const handler = this.eventHandlers.get(event);
    if (handler) {
      try {
        await handler(data);
      } catch (error) {
        console.error(`Error handling event ${event}:`, error);
        // Don't throw - events should be non-blocking
      }
    } else {
      // No handler for this event type - silently ignore
    }
  }

  /**
   * Handle user registration event
   * @param {Object} data - User registration data
   */
  async handleUserRegistration(data) {
    const { userId, userName, email } = data;

    // Create welcome notification
    await this.createNotification({
      userId,
      type: 'system_announcement',
      title: 'Welcome to TSCS!',
      message: `Welcome ${userName}! Your account has been created successfully. Please verify your email to access all features.`,
      isSystem: true
    });

    // Note: OTP email is sent separately by the OTP service
    // We don't send additional emails here to avoid double-sending
  }

  /**
   * Handle system notification event
   * @param {Object} data - System notification data
   */
  async handleSystemNotification(data) {
    const { userId, title, message, metadata, sendEmail = false, sendSMS = false } = data;

    // Create in-app notification
    const notification = await this.createNotification({
      userId,
      type: 'system_announcement',
      title,
      message,
      metadata,
      isSystem: true
    });

    // Send email if requested (email service also sends SMS when phone is available).
    if (sendEmail && userId) {
      try {
        const user = await User.findById(userId).select('email name phone');
        let sentViaEmailService = false;
        if (user && user.email) {
          const emailSent = await emailService.sendSystemNotification(
            user.email,
            title,
            message,
            user.name,
            metadata,
            user.phone
          );

          // Update notification with email status
          if (emailSent) {
            notification.emailSent = true;
            notification.emailSentAt = new Date();
            await notification.save();
          }

          sentViaEmailService = true;
        }

        // Fallback SMS path: when requested and email channel was not used.
        if ((sendSMS || sendEmail) && user?.phone && !sentViaEmailService) {
          const smsText = `TSCS: ${title}. ${message}`;
          await smsService.sendSMS(user.phone, smsText);
        }
      } catch (error) {
        console.error('Failed to send system notification email:', error);
      }
      return;
    }

    // SMS-only path
    if (sendSMS && userId) {
      try {
        const user = await User.findById(userId).select('phone');
        if (user?.phone) {
          const smsText = `TSCS: ${title}. ${message}`;
          await smsService.sendSMS(user.phone, smsText);
        }
      } catch (error) {
        console.error('Failed to send system notification SMS:', error);
      }
    }
  }

  /**
   * Handle competition round started
   * @param {Object} data - Round data
   */
  async handleCompetitionRoundStarted(data) {
    const { roundId, roundName, participants } = data;

    // Notify all participants
    for (const userId of participants) {
      await this.createNotification({
        userId,
        type: 'round_started',
        title: 'Competition Round Started',
        message: `The ${roundName} has begun. Please submit your entries before the deadline.`,
        metadata: { roundId, roundName }
      });
    }
  }

  /**
   * Handle competition round ending soon
   * @param {Object} data - Round data
   */
  async handleCompetitionRoundEndingSoon(data) {
    const { roundId, roundName, participants, hoursLeft } = data;

    for (const userId of participants) {
      await this.createNotification({
        userId,
        type: 'round_ending_soon',
        title: 'Round Ending Soon',
        message: `The ${roundName} ends in ${hoursLeft} hours. Make sure to submit your entries!`,
        metadata: { roundId, roundName, hoursLeft }
      });
    }
  }

  /**
   * Handle competition round ended
   * @param {Object} data - Round data
   */
  async handleCompetitionRoundEnded(data) {
    const { roundId, roundName, participants, promoted, eliminated } = data;

    // Notify promoted participants
    for (const userId of promoted) {
      await this.createNotification({
        userId,
        type: 'submission_promoted',
        title: 'Congratulations!',
        message: `Your submission has been promoted to the next round of ${roundName}!`,
        metadata: { roundId, roundName, status: 'promoted' }
      });
    }

    // Notify eliminated participants
    for (const userId of eliminated) {
      await this.createNotification({
        userId,
        type: 'submission_eliminated',
        title: 'Round Complete',
        message: `The ${roundName} has ended. Unfortunately, your submission was not promoted to the next round.`,
        metadata: { roundId, roundName, status: 'eliminated' }
      });
    }
  }

  /**
   * Handle submission promoted
   * @param {Object} data - Submission data
   */
  async handleSubmissionPromoted(data) {
    const { userId, submissionId, roundName } = data;

    await this.createNotification({
      userId,
      type: 'submission_promoted',
      title: 'Submission Promoted!',
      message: `Congratulations! Your submission has been promoted to the next round.`,
      metadata: { submissionId, roundName }
    });
  }

  /**
   * Handle submission eliminated
   * @param {Object} data - Submission data
   */
  async handleSubmissionEliminated(data) {
    const { userId, submissionId, roundName } = data;

    await this.createNotification({
      userId,
      type: 'submission_eliminated',
      title: 'Submission Status',
      message: `Your submission for ${roundName} has been evaluated.`,
      metadata: { submissionId, roundName }
    });
  }

  /**
   * Handle evaluation reminder
   * @param {Object} data - Evaluation data
   */
  async handleEvaluationReminder(data) {
    const { judgeId, submissionId, roundName, deadline } = data;

    await this.createNotification({
      userId: judgeId,
      type: 'evaluation_reminder',
      title: 'Evaluation Reminder',
      message: `You have pending evaluations for ${roundName}. Please complete them before ${deadline}.`,
      metadata: { submissionId, roundName, deadline }
    });
  }

  /**
   * Handle evaluation pending
   * @param {Object} data - Evaluation data
   */
  async handleEvaluationPending(data) {
    const { judgeId, submissionId, roundName } = data;

    await this.createNotification({
      userId: judgeId,
      type: 'evaluation_pending',
      title: 'New Evaluation Available',
      message: `A new submission is available for evaluation in ${roundName}.`,
      metadata: { submissionId, roundName }
    });
  }

  /**
   * Handle judge assignment (Email enabled)
   * Supports two formats:
   * 1. Round assignment: { judgeId, roundName, level }
   * 2. Submission assignment: { userId, submissionId, teacherName, subject, areaOfFocus, level, region, council }
   * @param {Object} data - Assignment data
   */
  async handleJudgeAssigned(data) {
    // Check if this is a submission assignment (new format)
    if (data.submissionId) {
      const { userId, submissionId, teacherName, subject, areaOfFocus, level, region, council } = data;
      const location = level === 'Council' ? `${region} - ${council}` : region;
      
      const notification = await this.createNotification({
        userId,
        type: 'judge_assigned',
        title: 'New Submission Assigned',
        message: `A new submission has been assigned to you for evaluation: ${subject} - ${location} (${level} Level).`,
        metadata: { submissionId, teacherName, subject, areaOfFocus, level, region, council }
      });

      // Send email notification
      await this.sendEmailNotification(userId, notification);
    } else {
      // Legacy format: round assignment
      const { judgeId, roundName, level } = data;

      const notification = await this.createNotification({
        userId: judgeId,
        type: 'judge_assigned',
        title: 'Judge Assignment',
        message: `You have been assigned as a judge for ${roundName} (${level} level).`,
        metadata: { roundName, level }
      });

      // Send email notification
      await this.sendEmailNotification(judgeId, notification);
    }
  }

  /**
   * Handle successful submission (Email enabled for teachers)
   * @param {Object} data - Submission data
   */
  async handleSubmissionSuccessful(data) {
    const { userId, submissionId, roundName, subject } = data;

    const notification = await this.createNotification({
      userId,
      type: 'submission_successful',
      title: 'Submission Successful',
      message: `Your submission for ${subject} in ${roundName} has been received successfully.`,
      metadata: { submissionId, roundName, subject }
    });

    // Send email notification
    await this.sendEmailNotification(userId, notification);
  }

  /**
   * Handle submission disqualified (Email enabled for teachers)
   * @param {Object} data - Disqualification data
   */
  async handleSubmissionDisqualified(data) {
    const {
      userId,
      submissionId,
      roundName,
      reason,
      subject,
      category,
      areaOfFocus
    } = data;

    const notification = await this.createNotification({
      userId,
      type: 'submission_disqualified',
      title: 'Submission Disqualified',
      message: `Your submission has been disqualified.${reason ? ` Reason: ${reason}` : ''}`,
      metadata: { submissionId, roundName, reason, subject, category, areaOfFocus }
    });

    await this.sendEmailNotification(userId, notification);
  }

  /**
   * Handle submission promoted (Email enabled for teachers)
   * @param {Object} data - Submission data
   */
  async handleSubmissionPromoted(data) {
    const { userId, submissionId, roundName, nextRound } = data;

    const notification = await this.createNotification({
      userId,
      type: 'submission_promoted',
      title: 'Congratulations! Submission Promoted',
      message: `Your submission has been promoted to ${nextRound || 'the next round'} of ${roundName}.`,
      metadata: { submissionId, roundName, nextRound }
    });

    // Send email notification
    await this.sendEmailNotification(userId, notification);
  }

  /**
   * Handle submission eliminated (Email enabled for teachers)
   * @param {Object} data - Submission data
   */
  async handleSubmissionEliminated(data) {
    const { userId, submissionId, roundName } = data;

    const notification = await this.createNotification({
      userId,
      type: 'submission_eliminated',
      title: 'Submission Results',
      message: `The evaluation period for ${roundName} has ended. Unfortunately, your submission was not selected to advance.`,
      metadata: { submissionId, roundName }
    });

    // Send email notification
    await this.sendEmailNotification(userId, notification);
  }

  /**
   * Handle evaluation reminder (Email enabled for judges)
   * @param {Object} data - Evaluation data
   */
  async handleEvaluationReminder(data) {
    const { judgeId, submissionId, roundName, deadline, hoursLeft } = data;

    const notification = await this.createNotification({
      userId: judgeId,
      type: 'evaluation_reminder',
      title: 'Evaluation Reminder',
      message: `You have ${hoursLeft} hours remaining to complete evaluations for ${roundName}. Deadline: ${deadline}.`,
      metadata: { submissionId, roundName, deadline, hoursLeft }
    });

    // Send email notification
    await this.sendEmailNotification(judgeId, notification);
  }

  /**
   * Handle evaluation pending (Email enabled for judges)
   * @param {Object} data - Evaluation data
   */
  async handleEvaluationPending(data) {
    const { judgeId, roundName, submissionCount, deadline } = data;

    const notification = await this.createNotification({
      userId: judgeId,
      type: 'evaluation_pending',
      title: 'New Evaluations Available',
      message: `${submissionCount} new submission(s) available for evaluation in ${roundName}. Deadline: ${deadline}.`,
      metadata: { roundName, submissionCount, deadline }
    });

    // Send email notification
    await this.sendEmailNotification(judgeId, notification);
  }

  /**
   * Send custom reminder to a specific judge
   * @param {String} judgeId - Judge user ID
   * @param {String} message - Custom reminder message
   * @param {Object} roundInfo - Round information
   */
  async sendCustomReminder(judgeId, message, roundInfo) {
    const { roundName, roundId, level, year } = roundInfo;

    const notification = await this.createNotification({
      userId: judgeId,
      type: 'evaluation_reminder',
      title: `Reminder: ${roundName}`,
      message: message,
      metadata: { roundId, roundName, level, year, isCustom: true }
    });

    // Send email notification
    await this.sendEmailNotification(judgeId, notification);
  }

  /**
   * Send reminder to all judges in a location
   * @param {Object} location - Location object with region and council
   * @param {String} message - Custom reminder message
   * @param {Object} roundInfo - Round information
   */
  async sendLocationReminder(location, message, roundInfo) {
    const { roundName, roundId, level, year } = roundInfo;
    const User = require('../models/User');

    // Build query for judges in the location
    const judgeQuery = {
      role: 'judge',
      status: 'active',
      assignedLevel: level
    };

    if (location.council) {
      judgeQuery.assignedRegion = location.region;
      judgeQuery.assignedCouncil = location.council;
    } else if (location.region) {
      judgeQuery.assignedRegion = location.region;
    }

    // Find all judges in the location
    const judges = await User.find(judgeQuery).select('_id');

    // Send reminder to each judge
    const promises = judges.map(async (judge) => {
      const notification = await this.createNotification({
        userId: judge._id.toString(),
        type: 'evaluation_reminder',
        title: `Reminder: ${roundName}`,
        message: message,
        metadata: { roundId, roundName, level, year, isCustom: true, isLocationReminder: true }
      });

      // Send email notification
      await this.sendEmailNotification(judge._id.toString(), notification);
    });

    await Promise.all(promises);
  }

  /**
   * Handle admin notification (Email enabled)
   * @param {Object} data - Admin notification data
   */
  async handleAdminNotification(data) {
    const { userId, adminId, title, message, priority = 'normal' } = data;

    const notification = await this.createNotification({
      userId,
      type: 'admin_notification',
      title: `Admin: ${title}`,
      message,
      metadata: { adminId, priority },
      isSystem: true,
      createdBy: adminId
    });

    // Send email notification
    await this.sendEmailNotification(userId, notification);
  }

  /**
   * Handle system critical event (Email enabled for admins)
   * @param {Object} data - Critical system data
   */
  async handleSystemCritical(data) {
    const { title, message, severity = 'high', adminIds } = data;

    // Notify all admins
    for (const adminId of adminIds) {
      const notification = await this.createNotification({
        userId: adminId,
        type: 'system_critical',
        title: `CRITICAL: ${title}`,
        message,
        metadata: { severity },
        isSystem: true
      });

      // Send email notification to admin
      await this.sendEmailNotification(adminId, notification);
    }
  }

  /**
   * Create and save notification
   * @param {Object} notificationData - Notification data
   * @returns {Promise<Object>} Created notification
   */
  async createNotification(notificationData) {
    try {
      const notification = await Notification.create(notificationData);
      return notification;
    } catch (error) {
      console.error('Failed to create notification:', error);
      throw error;
    }
  }

  /**
   * Send bulk notifications to multiple users
   * @param {Array} notifications - Array of notification objects
   * @param {boolean} sendEmail - Whether to send emails
   */
  async sendBulkNotifications(notifications, sendEmail = false) {
    const promises = notifications.map(notification =>
      this.emit('SYSTEM_NOTIFICATION', { ...notification, sendEmail })
    );

    try {
      await Promise.allSettled(promises); // Don't fail if some notifications fail
    } catch (error) {
      console.error('Bulk notification error:', error);
    }
  }

  /**
   * Mark notification as read
   * @param {string} notificationId - Notification ID
   * @param {string} userId - User ID
   */
  async markAsRead(notificationId, userId) {
    try {
      const notification = await Notification.findOneAndUpdate(
        { _id: notificationId, userId },
        { read: true, readAt: new Date() },
        { new: true }
      );
      return notification;
    } catch (error) {
      console.error('Failed to mark notification as read:', error);
      throw error;
    }
  }

  /**
   * Get user notifications
   * @param {string} userId - User ID
   * @param {Object} options - Query options
   * @returns {Promise<Array>} User notifications
   */
  async getUserNotifications(userId, options = {}) {
    const { limit = 50, offset = 0, unreadOnly = false } = options;

    try {
      const query = { userId };
      if (unreadOnly) {
        query.read = false;
      }

      const notifications = await Notification.find(query)
        .sort({ createdAt: -1 })
        .limit(limit)
        .skip(offset)
        .populate('createdBy', 'name')
        .lean();

      return notifications;
    } catch (error) {
      console.error('Failed to get user notifications:', error);
      throw error;
    }
  }

  /**
   * Send email notification for specific notification types
   * @param {string} userId - User ID
   * @param {Object} notification - Notification object
   */
  async sendEmailNotification(userId, notification) {
    try {
      const user = await User.findById(userId).select('email name phone');
      if (!user || !user.email) return;

      // Determine email type and send appropriate email
      switch (notification.type) {
        case 'submission_successful':
          await emailService.sendSubmissionSuccessfulEmail(
            user.email,
            user.name,
            notification.metadata,
            user.phone
          );
          break;

        case 'submission_promoted':
          await emailService.sendSubmissionResultEmail(
            user.email,
            user.name,
            'promoted',
            notification.metadata,
            user.phone
          );
          break;

        case 'submission_eliminated':
          await emailService.sendSubmissionResultEmail(
            user.email,
            user.name,
            'eliminated',
            notification.metadata,
            user.phone
          );
          break;

        case 'submission_disqualified':
          await emailService.sendSubmissionDisqualifiedEmail(
            user.email,
            user.name,
            notification.metadata,
            user.phone
          );
          break;

        case 'evaluation_reminder':
          await emailService.sendEvaluationReminderEmail(
            user.email,
            user.name,
            notification.metadata,
            user.phone
          );
          break;

        case 'evaluation_pending':
          await emailService.sendEvaluationPendingEmail(
            user.email,
            user.name,
            notification.metadata,
            user.phone
          );
          break;

        case 'judge_assigned':
          await emailService.sendJudgeAssignmentEmail(
            user.email,
            user.name,
            notification.metadata,
            user.phone
          );
          break;

        case 'admin_notification':
          await emailService.sendAdminNotificationEmail(
            user.email,
            user.name,
            notification.title,
            notification.message,
            notification.metadata,
            user.phone
          );
          break;

        case 'system_critical':
          await emailService.sendSystemCriticalEmail(
            user.email,
            user.name,
            notification.title,
            notification.message,
            notification.metadata,
            user.phone
          );
          break;
      }

      // Update notification with email sent status
      notification.emailSent = true;
      notification.emailSentAt = new Date();
      await notification.save();

    } catch (error) {
      console.error('Failed to send email notification:', error);
      // Don't fail the notification creation if email fails
    }
  }

  /**
   * Get unread notification count
   * @param {string} userId - User ID
   * @returns {Promise<number>} Count of unread notifications
   */
  async getUnreadCount(userId) {
    try {
      return await Notification.countDocuments({ userId, read: false });
    } catch (error) {
      console.error('Failed to get unread count:', error);
      return 0;
    }
  }
}

// Singleton instance
const notificationService = new NotificationService();

module.exports = notificationService;
