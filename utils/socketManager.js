const { Server } = require('socket.io');
const jwt = require('jsonwebtoken');
const User = require('../models/User');

let io = null;

/**
 * Initialize Socket.IO with the HTTP server
 * @param {Object} server - HTTP server instance
 * @param {Object} corsOptions - CORS configuration
 */
const initSocket = (server, corsOptions = {}) => {
  io = new Server(server, {
    cors: corsOptions,
    pingTimeout: 60000,
    pingInterval: 25000,
  });

  // JWT authentication middleware for socket connections
  io.use(async (socket, next) => {
    try {
      const token = socket.handshake.auth?.token || socket.handshake.query?.token;
      if (!token) {
        return next(new Error('Authentication required'));
      }

      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      const user = await User.findById(decoded.id).select('_id name role assignedLevel assignedRegion assignedCouncil');
      if (!user) {
        return next(new Error('User not found'));
      }

      if ((user.role === 'admin' || user.role === 'superadmin') && decoded.mfa !== true) {
        return next(new Error('Multi-factor authentication required'));
      }

      socket.user = user;
      next();
    } catch (error) {
      next(new Error('Invalid token'));
    }
  });

  io.on('connection', (socket) => {
    if (process.env.NODE_ENV === 'development') {
      console.log(`[Socket] User connected: ${socket.user?.name} (${socket.user?.role})`);
    }

    // Handle room subscriptions for leaderboard updates
    socket.on('subscribe-leaderboard', ({ year, level }) => {
      if (year && level) {
        const room = `leaderboard:${year}:${level}`;
        socket.join(room);
        if (process.env.NODE_ENV === 'development') {
          console.log(`[Socket] ${socket.user?.name} joined room: ${room}`);
        }
      }
    });

    socket.on('unsubscribe-leaderboard', ({ year, level }) => {
      if (year && level) {
        const room = `leaderboard:${year}:${level}`;
        socket.leave(room);
      }
    });

    socket.on('disconnect', () => {
      if (process.env.NODE_ENV === 'development') {
        console.log(`[Socket] User disconnected: ${socket.user?.name}`);
      }
    });
  });

  return io;
};

/**
 * Get the Socket.IO instance
 * @returns {Object|null} Socket.IO server instance
 */
const getIO = () => io;

/**
 * Emit a score update to the leaderboard room
 * @param {Number} year - Competition year
 * @param {String} level - Competition level
 * @param {Object} data - Score update data
 */
const emitScoreUpdate = (year, level, data) => {
  if (io) {
    io.to(`leaderboard:${year}:${level}`).emit('score-updated', {
      ...data,
      timestamp: new Date().toISOString(),
    });
  }
};

/**
 * Emit a round state change event
 * @param {Number} year - Competition year
 * @param {String} level - Competition level
 * @param {Object} data - Round state data
 */
const emitRoundStateChange = (year, level, data) => {
  if (io) {
    io.to(`leaderboard:${year}:${level}`).emit('round-state-changed', {
      ...data,
      timestamp: new Date().toISOString(),
    });
  }
};

/**
 * Emit a leaderboard mode change event (live/frozen)
 * @param {Number} year - Competition year
 * @param {String} level - Competition level
 * @param {Object} data - Mode change data
 */
const emitLeaderboardModeChange = (year, level, data) => {
  if (io) {
    io.to(`leaderboard:${year}:${level}`).emit('leaderboard-mode-changed', {
      ...data,
      timestamp: new Date().toISOString(),
    });
  }
};

module.exports = {
  initSocket,
  getIO,
  emitScoreUpdate,
  emitRoundStateChange,
  emitLeaderboardModeChange,
};
