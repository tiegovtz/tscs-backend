const jwt = require('jsonwebtoken');
const User = require('../models/User');

// Protect routes - verify JWT token
const protect = async (req, res, next) => {
  try {
    let token;

    // Check for token in Authorization header
    if (req.headers.authorization && req.headers.authorization.startsWith('Bearer')) {
      token = req.headers.authorization.split(' ')[1];
    }
    // Also check for token in query parameter (for iframe/file access)
    else if (req.query.token) {
      token = req.query.token;
    }

    if (!token) {
      return res.status(401).json({
        success: false,
        message: 'Not authorized, no token provided'
      });
    }

    try {
      // Verify token
      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      
      // Get user from token
      req.user = await User.findById(decoded.id).select('-password');
      
      if (!req.user) {
        return res.status(401).json({
          success: false,
          message: 'User not found'
        });
      }

      if (req.user.isDeleted) {
        return res.status(401).json({
          success: false,
          message: 'User account is deleted'
        });
      }

      if (req.user.status !== 'active') {
        return res.status(401).json({
          success: false,
          message: 'User account is not active'
        });
      }

      next();
    } catch (error) {
      if (error?.name === 'TokenExpiredError') {
        return res.status(401).json({
          success: false,
          message: 'Not authorized, token expired'
        });
      }

      return res.status(401).json({
        success: false,
        message: 'Not authorized, token failed'
      });
    }
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
};

// Role-based authorization
const authorize = (...roles) => {
  return (req, res, next) => {
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({
        success: false,
        message: `User role '${req.user.role}' is not authorized to access this route`
      });
    }
    next();
  };
};

// Only national admin or superadmin (for competitions, rounds, leaderboard finalize/advance)
const authorizeNationalAdminOrSuperadmin = (req, res, next) => {
  if (req.user.role === 'superadmin') return next();
  if (req.user.role === 'admin' && req.user.adminLevel === 'National') return next();
  return res.status(403).json({
    success: false,
    message: 'Only national admin or superadmin can perform this action'
  });
};

module.exports = { protect, authorize, authorizeNationalAdminOrSuperadmin };
