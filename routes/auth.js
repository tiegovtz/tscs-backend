const express = require('express');
const jwt = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');
const User = require('../models/User');
const PasswordReset = require('../models/PasswordReset');
const { protect } = require('../middleware/auth');
const OTPService = require('../services/otpService');
const emailService = require('../services/emailService');
const notificationService = require('../services/notificationService');
const { failedLoginLockout, recordFailedAttempt, clearFailedAttempts } = require('../services/failedLoginTracker');

// Safely import logger - if it fails, app should still work
let logger = null;
try {
  const loggerModule = require('../utils/logger');
  logger = loggerModule.logger;
} catch (error) {
  console.error('Warning: Logger not available:', error.message);
  // Create a no-op logger so the app doesn't crash
  logger = {
    logUserActivity: () => Promise.resolve(),
    logSecurity: () => Promise.resolve(),
    logAdminAction: () => Promise.resolve(),
    logSystemEvent: () => Promise.resolve(),
    logApiRequest: () => Promise.resolve(),
    logError: () => Promise.resolve(),
    log: () => Promise.resolve()
  };
}

const router = express.Router();

const JWT_EXPIRES_IN = String(process.env.JWT_EXPIRES_IN || '1h').trim() || '1h';

// Generate JWT Token
const generateToken = (id) => {
  return jwt.sign({ id }, process.env.JWT_SECRET, {
    expiresIn: JWT_EXPIRES_IN
  });
};

// @route   POST /api/auth/login
// @desc    Login user
// @access  Public
router.post('/login', failedLoginLockout, async (req, res) => {
  try {
    const { email, password } = req.body;

    // Validate input
    if (!email || !password) {
      return res.status(400).json({
        success: false,
        message: 'Please provide email and password'
      });
    }

    // Find user by email
    const user = await User.findOne({ email: email.toLowerCase(), isDeleted: { $ne: true } });

    if (!user) {
      // Log failed login attempt (non-blocking)
      if (logger) {
        logger.logSecurity(
          'Failed login attempt - user not found',
          null,
          req,
          { email: email.toLowerCase() },
          'warning'
        ).catch(() => {}); // Silently fail
      }
      await recordFailedAttempt(req.ip);
      return res.status(401).json({
        success: false,
        message: 'Invalid email or password'
      });
    }

    // Check if user is active
    if (user.status !== 'active') {
      // Log inactive account login attempt (non-blocking)
      if (logger) {
        logger.logSecurity(
          'Failed login attempt - inactive account',
          user._id,
          req,
          { email: email.toLowerCase(), status: user.status },
          'warning'
        ).catch(() => {}); // Silently fail
      }
      
      return res.status(401).json({
        success: false,
        message: 'Your account is not active. Please contact an administrator.'
      });
    }

    // Check password first (before email verification check)
    const isMatch = await user.comparePassword(password);

    if (!isMatch) {
      // Log failed login attempt (non-blocking)
      if (logger) {
        logger.logSecurity(
          'Failed login attempt - invalid password',
          user._id,
          req,
          { email: email.toLowerCase() },
          'warning'
        ).catch(() => {}); // Silently fail
      }
      await recordFailedAttempt(req.ip);
      return res.status(401).json({
        success: false,
        message: 'Invalid email or password'
      });
    }

    // Check if email is verified
    // For admin/judge/stakeholder users registered by admin: send OTP if not verified
    // For teacher users (self-registered): require verification before login
    if (!user.emailVerified) {
      // If user is admin, judge, or stakeholder (registered by admin), send OTP
      if (user.role === 'admin' || user.role === 'judge' || user.role === 'stakeholder') {
        // Generate and send OTP for email verification
        const otpResult = await OTPService.createOTP(user.email);

        if (!otpResult.success) {
          return res.status(500).json({
            success: false,
            message: 'Failed to send verification code. Please try again.'
          });
        }

        // Send OTP email (non-blocking)
        emailService.sendOTPVerification(user.email, otpResult.otp, user.name, user.phone)
          .catch(error => {
            console.error('Failed to send OTP email:', error.message);
          });

        // Log OTP sent for unverified admin/judge (non-blocking)
      if (logger) {
        logger.logSecurity(
            'OTP sent for unverified admin/judge login',
            user._id,
            req,
            { email: email.toLowerCase(), role: user.role },
            'info'
          ).catch(() => {}); // Silently fail
        }

        // Return special response indicating OTP is required
        return res.status(200).json({
          success: false,
          requiresOTP: true,
          message: 'Please verify your email address. A verification code has been sent to your email.',
          email: user.email
        });
      } else {
        // For teacher users, require verification before login
        if (logger) {
          logger.logSecurity(
            'Failed login attempt - unverified email (teacher)',
          user._id,
          req,
          { email: email.toLowerCase() },
          'warning'
        ).catch(() => {}); // Silently fail
      }
      
      return res.status(401).json({
        success: false,
          message: 'Please verify your email address before logging in.'
      });
      }
    }

    // Generate token
    const token = generateToken(user._id);
    await clearFailedAttempts(req.ip);

    // Log successful login (non-blocking)
    if (logger) {
      logger.logUserActivity(
        'User logged in',
        user._id,
        req,
        { role: user.role }
      ).catch(() => {}); // Silently fail
    }

    // Ensure response is sent
    if (!res.headersSent) {
    res.json({
      success: true,
      token,
      user: {
        id: user._id,
        username: user.username,
        name: user.name,
        email: user.email,
        phone: user.phone,
        gender: user.gender,
        role: user.role,
        ...(user.role === 'teacher' && {
          school: user.school,
          region: user.region,
          council: user.council,
          chequeNumber: user.chequeNumber,
          subject: user.subject
        }),
        ...(user.role === 'judge' && {
          assignedLevel: user.assignedLevel,
          assignedRegion: user.assignedRegion,
          assignedCouncil: user.assignedCouncil,
          specialization: user.specialization,
          experience: user.experience
        }),
        ...(user.role === 'admin' && {
          adminLevel: user.adminLevel,
          adminRegion: user.adminRegion,
          adminCouncil: user.adminCouncil
        })
      }
    });
    }
  } catch (error) {
    console.error('Login error:', error);
    if (!res.headersSent) {
    res.status(500).json({
      success: false,
        message: error.message || 'Server error during login'
    });
    }
  }
});

// Rate limiter for OTP endpoints
// Note: trustProxy is configured on the Express app (server.js), rate limiter uses it automatically
const otpLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10, // 10 requests per window
  message: {
    success: false,
    message: 'Too many OTP requests. Please try again later.'
  },
  standardHeaders: true,
  legacyHeaders: false
});

// Stricter rate limiter for OTP verification (prevents brute force)
// Note: trustProxy is configured on the Express app (server.js), rate limiter uses it automatically
const otpVerifyLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 5, // 5 verification attempts per window
  message: {
    success: false,
    message: 'Too many verification attempts. Please try again later.'
  },
  standardHeaders: true,
  legacyHeaders: false
});

// @route   POST /api/auth/register
// @desc    Register new user (teacher) - sends OTP for email verification
// @access  Public
router.post('/register', async (req, res) => {
  try {
    const {
      firstName,
      lastName,
      email,
      phone,
      gender,
      schoolName,
      chequeNumber,
      region,
      council,
      password
    } = req.body;

    // Validate required fields
    if (!firstName || !lastName || !email || !password || !schoolName || !region || !council) {
      return res.status(400).json({
        success: false,
        message: 'Please provide all required fields'
      });
    }

    // Check if user already exists
    const existingUser = await User.findOne({
      email: email.toLowerCase(),
      isDeleted: { $ne: true }
    });

    if (existingUser) {
      // Don't reveal if email exists for security
      return res.status(400).json({
        success: false,
        message: 'An account with this email already exists'
      });
    }

    // Create username from email
    const username = email.toLowerCase();

    // Create user data (emailVerified: false by default)
    const userData = {
      username,
      password,
      name: `${firstName} ${lastName}`,
      email: email.toLowerCase(),
      phone: phone || '',
      role: 'teacher',
      status: 'active',
      emailVerified: false, // Explicitly set to false
      school: schoolName,
      region,
      council,
      ...(chequeNumber && { chequeNumber }),
      ...(gender && { gender })
    };

    const user = await User.create(userData);

    // Generate and send OTP
    const otpResult = await OTPService.createOTP(user.email);

    if (!otpResult.success) {
      // If OTP creation fails, delete the user to avoid orphaned accounts
      await User.findByIdAndDelete(user._id);
      return res.status(500).json({
        success: false,
        message: 'Failed to send verification code. Please try again.'
      });
    }

    // Send OTP email (non-blocking)
    emailService.sendOTPVerification(user.email, otpResult.otp, user.name, user.phone)
      .catch(error => {
        console.error('Failed to send OTP email:', error.message);
      });

    // Emit registration event (non-blocking)
    notificationService.emit('USER_REGISTERED', {
      userId: user._id,
      userName: user.name,
      email: user.email
    }).catch(error => {
      console.error('Failed to emit registration event:', error);
    });

    // Log user registration (non-blocking)
    if (logger) {
      logger.logUserActivity(
        'User registered - pending email verification',
        user._id,
        req,
        { role: 'teacher', region, council, school: schoolName }
      ).catch(() => {}); // Silently fail
    }

    res.status(201).json({
      success: true,
      message: 'Account created successfully. Please check your email for verification code.',
      user: {
        id: user._id,
        name: user.name,
        email: user.email,
        role: user.role,
        emailVerified: false
      }
    });
  } catch (error) {
    console.error('Registration error:', error);
    
    // Handle duplicate key error
    if (error.code === 11000) {
      return res.status(400).json({
        success: false,
        message: 'An account with this email already exists'
      });
    }

    res.status(500).json({
      success: false,
      message: 'Server error during registration'
    });
  }
});

// @route   POST /api/auth/verify-otp
// @desc    Verify email with OTP and complete registration
// @access  Public
router.post('/verify-otp', otpVerifyLimiter, async (req, res) => {
  try {
    const { email, otp } = req.body;

    // Validate input
    if (!email || !otp) {
      return res.status(400).json({
        success: false,
        message: 'Email and verification code are required'
      });
    }

    // Verify OTP
    const verifyResult = await OTPService.verifyOTPAndUpdate(email, otp);

    if (!verifyResult.success) {
      return res.status(400).json({
        success: false,
        message: verifyResult.error || 'Invalid verification code'
      });
    }

    // Generate JWT token
    const token = generateToken(verifyResult.user.id);

    // Log successful verification (non-blocking)
    if (logger) {
      logger.logUserActivity(
        'Email verified - account activated',
        verifyResult.user.id,
        req,
        { email: email.toLowerCase() }
      ).catch(() => {}); // Silently fail
    }

    // Send onboarding completion notification (email + SMS via notification service)
    notificationService.emit('SYSTEM_NOTIFICATION', {
      userId: verifyResult.user.id,
      title: 'Registration Complete',
      message: 'Your TSCS registration is complete. You can now access all features.',
      metadata: { event: 'registration_complete' },
      sendEmail: true
    }).catch((notifyError) => {
      console.error('Failed to emit registration complete notification:', notifyError);
    });

    res.json({
      success: true,
      message: 'Email verified successfully. Welcome to TSCS!',
      token,
      user: verifyResult.user
    });
  } catch (error) {
    console.error('OTP verification error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error during verification'
    });
  }
});

// @route   POST /api/auth/verify-otp-and-login
// @desc    Verify OTP for admin/judge login and complete login process
// @access  Public
router.post('/verify-otp-and-login', otpVerifyLimiter, async (req, res) => {
  try {
    const { email, otp } = req.body;

    // Validate input
    if (!email || !otp) {
      return res.status(400).json({
        success: false,
        message: 'Email and verification code are required'
      });
    }

    // Find user
    const user = await User.findOne({ email: email.toLowerCase(), isDeleted: { $ne: true } });

    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    // Only allow this for admin/judge/stakeholder users
    if (user.role !== 'admin' && user.role !== 'judge' && user.role !== 'stakeholder') {
      return res.status(403).json({
        success: false,
        message: 'This verification method is only for admin, judge, and stakeholder accounts'
      });
    }

    // Verify OTP and update email verification status
    const verifyResult = await OTPService.verifyOTPAndUpdate(email, otp);

    if (!verifyResult.success) {
      return res.status(400).json({
        success: false,
        message: verifyResult.error || 'Invalid verification code'
      });
    }

    // Generate JWT token
    const token = generateToken(user._id);

    // Log successful verification and login (non-blocking)
    if (logger) {
      logger.logUserActivity(
        'Email verified and logged in',
        user._id,
        req,
        { email: email.toLowerCase(), role: user.role }
      ).catch(() => {}); // Silently fail
    }

    // Send onboarding completion notification (email + SMS via notification service)
    notificationService.emit('SYSTEM_NOTIFICATION', {
      userId: user._id,
      title: 'Registration Complete',
      message: 'Your TSCS account setup is complete and your account is now active.',
      metadata: { event: 'registration_complete', role: user.role },
      sendEmail: true
    }).catch((notifyError) => {
      console.error('Failed to emit registration complete notification:', notifyError);
    });

    // Return login response with full user data
    if (!res.headersSent) {
      res.json({
        success: true,
        message: 'Email verified successfully. Welcome!',
        token,
        user: {
          id: user._id,
          username: user.username,
          name: user.name,
          email: user.email,
          phone: user.phone,
          gender: user.gender,
          role: user.role,
          ...(user.role === 'judge' && {
            assignedLevel: user.assignedLevel,
            assignedRegion: user.assignedRegion,
            assignedCouncil: user.assignedCouncil,
            specialization: user.specialization,
            experience: user.experience
          }),
          ...(user.role === 'admin' && {
            department: user.department
          })
        }
      });
    }
  } catch (error) {
    console.error('Verify OTP and login error:', error);
    if (!res.headersSent) {
      res.status(500).json({
        success: false,
        message: error.message || 'Server error during verification'
      });
    }
  }
});

// @route   POST /api/auth/resend-otp
// @desc    Resend OTP for email verification
// @access  Public
router.post('/resend-otp', otpLimiter, async (req, res) => {
  try {
    const { email } = req.body;

    // Validate input
    if (!email) {
      return res.status(400).json({
        success: false,
        message: 'Email is required'
      });
    }

    // Resend OTP
    const resendResult = await OTPService.resendOTP(email);

    if (!resendResult.success) {
      return res.status(resendResult.cooldownRemaining ? 429 : 400).json({
        success: false,
        message: resendResult.error || 'Failed to resend verification code',
        ...(resendResult.cooldownRemaining && { cooldownRemaining: resendResult.cooldownRemaining })
      });
    }

    // Send OTP email (non-blocking)
    const user = await User.findOne({ email: email.toLowerCase(), isDeleted: { $ne: true } });
    if (user) {
      emailService.sendOTPVerification(user.email, resendResult.otp, user.name, user.phone)
        .catch(error => {
            console.error('Failed to resend OTP email:', error.message);
        });
    }

    res.json({
      success: true,
      message: 'Verification code sent successfully. Please check your email.'
    });
  } catch (error) {
    console.error('OTP resend error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error during resend'
    });
  }
});

// Rate limiter for password reset requests
// Note: trustProxy is configured on the Express app (server.js), rate limiter uses it automatically
const passwordResetLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 5, // 5 password reset requests per window
  message: {
    success: false,
    message: 'Too many password reset requests. Please try again later.'
  },
  standardHeaders: true,
  legacyHeaders: false
});

// @route   POST /api/auth/forgot-password
// @desc    Request password reset - sends OTP for verification
// @access  Public
router.post('/forgot-password', passwordResetLimiter, async (req, res) => {
  try {
    const { email } = req.body;

    // Validate input
    if (!email) {
      return res.status(400).json({
        success: false,
        message: 'Email is required'
      });
    }

    // Find user by email
    const user = await User.findOne({ email: email.toLowerCase(), isDeleted: { $ne: true } });
    if (!user) {
      // Don't reveal if email exists for security
      return res.json({
        success: true,
        message: 'If an account with this email exists, you will receive a password reset code.'
      });
    }

    // Check if user is active
    if (user.status !== 'active') {
      return res.json({
        success: true,
        message: 'If an account with this email exists, you will receive a password reset code.'
      });
    }

    // Generate OTP for password reset
    const otpResult = await OTPService.createPasswordResetOTP(user.email);

    if (!otpResult.success) {
      console.error('Failed to create password reset OTP:', otpResult.error);
      return res.status(500).json({
        success: false,
        message: 'Failed to send password reset code. Please try again.'
      });
    }

    // Send password reset OTP email (non-blocking)
    emailService.sendPasswordResetOTP(user.email, otpResult.otp, user.name, user.phone)
      .catch(error => {
        console.error('Failed to send password reset OTP email:', error.message);
      });

    // Log security event (non-blocking)
    if (logger) {
      logger.logSecurity(
        'Password reset requested',
        user._id,
        req,
        { email: email.toLowerCase() },
        'info'
      ).catch(() => {});
    }

    res.json({
      success: true,
      message: 'If an account with this email exists, you will receive a password reset code.'
    });
  } catch (error) {
    console.error('Forgot password error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error during password reset request'
    });
  }
});

// @route   POST /api/auth/verify-password-reset-otp
// @desc    Verify OTP and create password reset token
// @access  Public
router.post('/verify-password-reset-otp', otpVerifyLimiter, async (req, res) => {
  try {
    const { email, otp } = req.body;

    // Validate input
    if (!email || !otp) {
      return res.status(400).json({
        success: false,
        message: 'Email and verification code are required'
      });
    }

    // Verify OTP (same as email verification)
    const verifyResult = await OTPService.verifyOTPAndUpdate(email, otp);

    if (!verifyResult.success) {
      return res.status(400).json({
        success: false,
        message: verifyResult.error || 'Invalid verification code'
      });
    }

    // Create password reset token
    const resetToken = PasswordReset.generateResetToken();
    const hashedToken = PasswordReset.hashResetToken(resetToken);

    // Invalidate any existing reset tokens for this user
    await PasswordReset.invalidateUserTokens(verifyResult.user.id);

    // Create new password reset record (expires in 15 minutes)
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000);

    await PasswordReset.create({
      userId: verifyResult.user.id,
      email: email.toLowerCase(),
      resetToken: hashedToken,
      expiresAt
    });

    // Log security event (non-blocking)
    if (logger) {
      logger.logSecurity(
        'Password reset OTP verified - reset token created',
        verifyResult.user.id,
        req,
        { email: email.toLowerCase() },
        'info'
      ).catch(() => {});
    }

    res.json({
      success: true,
      message: 'Verification successful. You can now reset your password.',
      resetToken: resetToken // Send plain token to client
    });
  } catch (error) {
    console.error('Password reset OTP verification error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error during verification'
    });
  }
});

// @route   POST /api/auth/reset-password
// @desc    Reset password using reset token
// @access  Public
router.post('/reset-password', async (req, res) => {
  try {
    const { resetToken, newPassword } = req.body;

    // Validate input
    if (!resetToken || !newPassword) {
      return res.status(400).json({
        success: false,
        message: 'Reset token and new password are required'
      });
    }

    // Validate password strength
    if (newPassword.length < 8) {
      return res.status(400).json({
        success: false,
        message: 'Password must be at least 8 characters long'
      });
    }

    // Hash the reset token to find the record
    const hashedToken = PasswordReset.hashResetToken(resetToken);

    // Find valid reset token
    const resetRecord = await PasswordReset.findValidToken(hashedToken);

    if (!resetRecord) {
      return res.status(400).json({
        success: false,
        message: 'Invalid or expired reset token'
      });
    }

    // Get user and update password
    const user = resetRecord.userId;
    user.password = newPassword; // Will be hashed by pre-save middleware
    await user.save();

    // Mark token as used
    await resetRecord.markUsed();

    // Log security event (non-blocking)
    if (logger) {
      logger.logSecurity(
        'Password reset completed',
        user._id,
        req,
        { email: resetRecord.email },
        'info'
      ).catch(() => {});
    }

    res.json({
      success: true,
      message: 'Password reset successful. You can now log in with your new password.'
    });
  } catch (error) {
    console.error('Password reset error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error during password reset'
    });
  }
});

// @route   GET /api/auth/me
// @desc    Get current user
// @access  Private
router.get('/me', protect, async (req, res) => {
  try {
    const user = await User.findById(req.user._id).select('-password');

    // Log profile view (non-blocking)
    if (logger) {
      logger.logUserActivity(
        'User viewed profile',
        user._id,
        req,
        {},
        'read'
      ).catch(() => {}); // Silently fail
    }

    res.json({
      success: true,
      user
    });
  } catch (error) {
    console.error('Get user error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
});

// @route   PUT /api/auth/profile
// @desc    Update current user profile
// @access  Private
router.put('/profile', protect, async (req, res) => {
  try {
    const {
      firstName,
      lastName,
      email,
      phone,
      gender,
      schoolName,
      chequeNumber,
      region,
      council
    } = req.body;

    // Build update object
    const updateData = {};
    if (firstName && lastName) updateData.name = `${firstName} ${lastName}`;
    if (email) updateData.email = email.toLowerCase();
    if (phone !== undefined) updateData.phone = phone;
    if (gender) updateData.gender = gender;
    if (schoolName !== undefined) updateData.school = schoolName;
    if (chequeNumber !== undefined) updateData.chequeNumber = chequeNumber;
    if (region !== undefined) updateData.region = region;
    if (council !== undefined) updateData.council = council;

    const user = await User.findByIdAndUpdate(
      req.user._id,
      updateData,
      { new: true, runValidators: true }
    ).select('-password');

    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    // Log profile update (non-blocking)
    if (logger) {
      logger.logUserActivity(
        'User updated profile',
        user._id,
        req,
        { updatedFields: Object.keys(updateData) },
        'update'
      ).catch(() => {}); // Silently fail
    }

    res.json({
      success: true,
      user
    });
  } catch (error) {
    console.error('Profile update error:', error);
    
    // Handle duplicate key error
    if (error.code === 11000) {
      const field = Object.keys(error.keyPattern)[0];
      return res.status(400).json({
        success: false,
        message: `${field} already exists`
      });
    }

    res.status(500).json({
      success: false,
      message: error.message || 'Server error'
    });
  }
});

// @route   PUT /api/auth/change-password
// @desc    Change password for authenticated user
// @access  Private
router.put('/change-password', protect, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;

    // Validate input
    if (!currentPassword || !newPassword) {
      return res.status(400).json({
        success: false,
        message: 'Current password and new password are required'
      });
    }

    // Validate new password strength
    if (newPassword.length < 8) {
      return res.status(400).json({
        success: false,
        message: 'New password must be at least 8 characters long'
      });
    }

    if (!/(?=.*[a-z])/.test(newPassword)) {
      return res.status(400).json({
        success: false,
        message: 'New password must contain at least one lowercase letter'
      });
    }

    if (!/(?=.*[A-Z])/.test(newPassword)) {
      return res.status(400).json({
        success: false,
        message: 'New password must contain at least one uppercase letter'
      });
    }

    if (!/(?=.*\d)/.test(newPassword)) {
      return res.status(400).json({
        success: false,
        message: 'New password must contain at least one number'
      });
    }

    // Get current user with password
    const user = await User.findById(req.user._id);

    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    // Verify current password
    const isCurrentPasswordValid = await user.comparePassword(currentPassword);

    if (!isCurrentPasswordValid) {
      // Log failed password change attempt (non-blocking)
      if (logger) {
        logger.logSecurity(
          'Failed password change - invalid current password',
          user._id,
          req,
          {},
          'warning'
        ).catch(() => {});
      }

      return res.status(400).json({
        success: false,
        message: 'Current password is incorrect'
      });
    }

    // Check if new password is different from current
    const isSamePassword = await user.comparePassword(newPassword);
    if (isSamePassword) {
      return res.status(400).json({
        success: false,
        message: 'New password must be different from current password'
      });
    }

    // Update password (will be hashed by pre-save middleware)
    user.password = newPassword;
    await user.save();

    // Log successful password change (non-blocking)
    if (logger) {
      logger.logSecurity(
        'Password changed successfully',
        user._id,
        req,
        {},
        'info'
      ).catch(() => {});
    }

    res.json({
      success: true,
      message: 'Password changed successfully'
    });
  } catch (error) {
    console.error('Change password error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error during password change'
    });
  }
});

// @route   POST /api/auth/request-email-change
// @desc    Send OTP to new email for verification before changing
// @access  Private
router.post('/request-email-change', protect, async (req, res) => {
  try {
    const { newEmail } = req.body;

    // Validate input
    if (!newEmail) {
      return res.status(400).json({
        success: false,
        message: 'New email is required'
      });
    }

    // Validate email format
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(newEmail)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid email format'
      });
    }

    const normalizedEmail = newEmail.toLowerCase();

    // Check if new email is same as current
    if (normalizedEmail === req.user.email.toLowerCase()) {
      return res.status(400).json({
        success: false,
        message: 'New email must be different from your current email'
      });
    }

    // Create OTP for the new email
    const otpResult = await OTPService.createEmailChangeOTP(normalizedEmail);

    if (!otpResult.success) {
      return res.status(400).json({
        success: false,
        message: otpResult.error
      });
    }

    // Send OTP to the new email
    try {
      await emailService.sendOTPVerification(normalizedEmail, otpResult.otp, req.user.name, req.user.phone);
    } catch (emailError) {
      console.error('Failed to send email change OTP:', emailError);
      return res.status(500).json({
        success: false,
        message: 'Failed to send verification email. Please try again.'
      });
    }

    // Log email change request (non-blocking)
    if (logger) {
      logger.logUserActivity(
        'Email change verification requested',
        req.user._id,
        req,
        { newEmail: normalizedEmail }
      ).catch(() => {});
    }

    res.json({
      success: true,
      message: 'Verification code sent to your new email address'
    });
  } catch (error) {
    console.error('Request email change error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error during email change request'
    });
  }
});

// @route   POST /api/auth/verify-email-change
// @desc    Verify OTP and update user email
// @access  Private
router.post('/verify-email-change', protect, async (req, res) => {
  try {
    const { newEmail, otp } = req.body;

    // Validate input
    if (!newEmail || !otp) {
      return res.status(400).json({
        success: false,
        message: 'New email and verification code are required'
      });
    }

    const normalizedEmail = newEmail.toLowerCase();

    // Verify the OTP
    const verifyResult = await OTPService.verifyEmailChangeOTP(normalizedEmail, otp);

    if (!verifyResult.success) {
      return res.status(400).json({
        success: false,
        message: verifyResult.error
      });
    }

    // OTP is valid - update the user's email
    const oldEmail = req.user.email;

    try {
      const updatedUser = await User.findByIdAndUpdate(
        req.user._id,
        { 
          email: normalizedEmail,
          emailVerified: true // Mark as verified since we just verified via OTP
        },
        { new: true, runValidators: true }
      ).select('-password');

      if (!updatedUser) {
        return res.status(404).json({
          success: false,
          message: 'User not found'
        });
      }

      // Log successful email change (non-blocking)
      if (logger) {
        logger.logSecurity(
          'Email changed successfully',
          req.user._id,
          req,
          { oldEmail, newEmail: normalizedEmail },
          'info'
        ).catch(() => {});
      }

      res.json({
        success: true,
        message: 'Email updated successfully',
        user: {
          id: updatedUser._id,
          name: updatedUser.name,
          email: updatedUser.email,
          emailVerified: updatedUser.emailVerified,
          role: updatedUser.role,
          phone: updatedUser.phone
        }
      });
    } catch (updateError) {
      // Handle duplicate email error
      if (updateError.code === 11000) {
        return res.status(400).json({
          success: false,
          message: 'This email is already registered to another account'
        });
      }
      throw updateError;
    }
  } catch (error) {
    console.error('Verify email change error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error during email verification'
    });
  }
});

module.exports = router;
