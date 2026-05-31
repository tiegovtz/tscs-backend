const express = require('express');
const Notification = require('../models/Notification');
const User = require('../models/User');
const { protect, authorize } = require('../middleware/auth');

// Safely import logger
let logger = null;
try {
  const loggerModule = require('../utils/logger');
  logger = loggerModule.logger;
} catch (error) {
  logger = {
    logUserActivity: () => Promise.resolve()
  };
}

const router = express.Router();

const TEACHER_HIDDEN_NOTIFICATION_TYPES = ['evaluation_reminder', 'evaluation_pending', 'judge_assigned'];

const sanitizeNotificationForTeacher = (notification) => {
  if (!notification) return notification;
  const plain = (typeof notification.toObject === 'function')
    ? notification.toObject()
    : { ...notification };

  if (plain.metadata && typeof plain.metadata === 'object') {
    const sanitizedMetadata = { ...plain.metadata };
    delete sanitizedMetadata.averageScore;
    delete sanitizedMetadata.totalScore;
    delete sanitizedMetadata.score;
    delete sanitizedMetadata.rank;
    delete sanitizedMetadata.totalSubmissions;
    delete sanitizedMetadata.totalEvaluations;
    delete sanitizedMetadata.evaluations;
    delete sanitizedMetadata.judgeCompleted;
    delete sanitizedMetadata.judgeCompletionStatus;
    plain.metadata = sanitizedMetadata;
  }

  return plain;
};

// All routes require authentication
router.use(protect);

// @route   GET /api/notifications
// @desc    Get user's notifications
// @access  Private
router.get('/', async (req, res) => {
  try {
    // Ensure user is authenticated
    if (!req.user || !req.user._id) {
      return res.status(401).json({
        success: false,
        message: 'Unauthorized'
      });
    }

    const { read, type, limit = 50 } = req.query;
    
    let query = { userId: req.user._id };

    if (req.user.role === 'teacher') {
      query.type = { $nin: TEACHER_HIDDEN_NOTIFICATION_TYPES };
    }
    
    if (read !== undefined) {
      query.read = read === 'true';
    }
    
    if (type) {
      if (req.user.role === 'teacher' && TEACHER_HIDDEN_NOTIFICATION_TYPES.includes(type)) {
        return res.json({
          success: true,
          count: 0,
          unreadCount: 0,
          notifications: []
        });
      }
      query.type = type;
    }

    const notifications = await Notification.find(query)
      .sort({ createdAt: -1 })
      .limit(parseInt(limit));

    // Get unread count
    const unreadQuery = {
      userId: req.user._id,
      read: false
    };
    if (req.user.role === 'teacher') {
      unreadQuery.type = { $nin: TEACHER_HIDDEN_NOTIFICATION_TYPES };
    }
    const unreadCount = await Notification.countDocuments(unreadQuery);

    const visibleNotifications = req.user.role === 'teacher'
      ? notifications.map((notification) => sanitizeNotificationForTeacher(notification))
      : notifications;

    if (!res.headersSent) {
      res.json({
        success: true,
        count: visibleNotifications.length,
        unreadCount: unreadCount || 0,
        notifications: visibleNotifications
      });
    }
  } catch (error) {
    console.error('Get notifications error:', error);
    if (!res.headersSent) {
      res.status(500).json({
        success: false,
        message: error.message || 'Server error'
      });
    }
  }
});

// @route   GET /api/notifications/unread-count
// @desc    Get unread notification count
// @access  Private
router.get('/unread-count', async (req, res) => {
  try {
    // Ensure user is authenticated
    if (!req.user || !req.user._id) {
      return res.status(401).json({
        success: false,
        message: 'Unauthorized'
      });
    }

    const countQuery = {
      userId: req.user._id,
      read: false
    };
    if (req.user.role === 'teacher') {
      countQuery.type = { $nin: TEACHER_HIDDEN_NOTIFICATION_TYPES };
    }
    const count = await Notification.countDocuments(countQuery);

    if (!res.headersSent) {
      res.json({
        success: true,
        count: count || 0
      });
    }
  } catch (error) {
    console.error('Get unread count error:', error);
    if (!res.headersSent) {
      res.status(500).json({
        success: false,
        message: error.message || 'Server error'
      });
    }
  }
});

// @route   PUT /api/notifications/:id/read
// @desc    Mark notification as read
// @access  Private
router.put('/:id/read', async (req, res) => {
  try {
    const notification = await Notification.findOne({
      _id: req.params.id,
      userId: req.user._id
    });

    if (!notification) {
      return res.status(404).json({
        success: false,
        message: 'Notification not found'
      });
    }

    notification.read = true;
    notification.readAt = new Date();
    await notification.save();

    // Log activity
    if (logger) {
      logger.logUserActivity(
        'User marked notification as read',
        req.user._id,
        req,
        { notificationId: req.params.id },
        'update'
      ).catch(() => {});
    }

    res.json({
      success: true,
      notification
    });
  } catch (error) {
    console.error('Mark notification as read error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
});

// @route   PUT /api/notifications/read-all
// @desc    Mark all notifications as read
// @access  Private
router.put('/read-all', async (req, res) => {
  try {
    const result = await Notification.updateMany(
      { userId: req.user._id, read: false },
      { read: true, readAt: new Date() }
    );

    // Log activity
    if (logger) {
      logger.logUserActivity(
        'User marked all notifications as read',
        req.user._id,
        req,
        { count: result.modifiedCount },
        'update'
      ).catch(() => {});
    }

    res.json({
      success: true,
      count: result.modifiedCount
    });
  } catch (error) {
    console.error('Mark all notifications as read error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
});

// @route   DELETE /api/notifications/:id
// @desc    Delete notification (cannot delete system notifications)
// @access  Private
router.delete('/:id', async (req, res) => {
  try {
    const notification = await Notification.findOne({
      _id: req.params.id,
      userId: req.user._id
    });

    if (!notification) {
      return res.status(404).json({
        success: false,
        message: 'Notification not found'
      });
    }

    // Prevent deletion of system notifications
    if (notification.isSystem) {
      return res.status(403).json({
        success: false,
        message: 'Cannot delete system notifications'
      });
    }

    await Notification.findByIdAndDelete(req.params.id);

    // Log activity
    if (logger) {
      logger.logUserActivity(
        'User deleted notification',
        req.user._id,
        req,
        { notificationId: req.params.id },
        'delete'
      ).catch(() => {});
    }

    res.json({
      success: true,
      message: 'Notification deleted'
    });
  } catch (error) {
    console.error('Delete notification error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
});

// @route   POST /api/notifications/send
// @desc    Send notification to user(s) (Admin/Superadmin only)
// @access  Private (Admin/Superadmin)
router.post('/send', authorize('admin', 'superadmin'), async (req, res) => {
  try {
    const { userIds, title, message, type = 'system_announcement' } = req.body;

    if (!userIds || !Array.isArray(userIds) || userIds.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'Please provide at least one user ID'
      });
    }

    if (!title || !message) {
      return res.status(400).json({
        success: false,
        message: 'Please provide title and message'
      });
    }

    // Verify all users exist
    const users = await User.find({ _id: { $in: userIds } });
    if (users.length !== userIds.length) {
      return res.status(400).json({
        success: false,
        message: 'One or more users not found'
      });
    }

    // Create notifications for all users
    const notifications = userIds.map(userId => ({
      userId,
      type,
      title,
      message,
      isSystem: false, // Admin-created notifications are not system notifications
      createdBy: req.user._id,
      read: false
    }));

    const createdNotifications = await Notification.insertMany(notifications);

    // Log activity
    if (logger) {
      logger.logAdminAction(
        `Admin sent notification to ${userIds.length} user(s)`,
        req.user._id,
        req,
        {
          notificationCount: createdNotifications.length,
          title,
          userIds
        },
        'success',
        'create'
      ).catch(() => {});
    }

    res.json({
      success: true,
      count: createdNotifications.length,
      notifications: createdNotifications
    });
  } catch (error) {
    console.error('Send notification error:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Server error'
    });
  }
});

module.exports = router;
