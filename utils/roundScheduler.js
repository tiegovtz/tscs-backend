const CompetitionRound = require('../models/CompetitionRound');
const AreaLeaderboard = require('../models/AreaLeaderboard');
const { activateDueChunksForRound } = require('./roundJudgementService');

// Safely import logger
let logger = null;
try {
  const loggerModule = require('./logger');
  logger = loggerModule.logger;
} catch (error) {
  logger = {
    logSystemEvent: () => Promise.resolve(),
    logError: () => Promise.resolve()
  };
}

// Check and process rounds that should end
const checkAndProcessRounds = async () => {
  try {
    const mongoose = require('mongoose');
    if (mongoose.connection.readyState !== 1) {
      return;
    }

    const now = new Date();

    // Transition active rounds to ended when their timer finishes.
    // Manual superadmin approval/publish flow handles promotions and closure.
    const activeRounds = await CompetitionRound.find({
      status: 'active',
      stage: { $ne: 'face_to_face' }
    });
    for (const round of activeRounds) {
      await activateDueChunksForRound(round);

      const actualEndTime = typeof round.getActualEndTime === 'function'
        ? round.getActualEndTime()
        : round.endTime;

      if (!actualEndTime) {
        continue;
      }

      if (now >= actualEndTime) {
        round.status = 'ended';
        round.endedAt = round.endedAt || now;
        await round.save();

        if (logger) {
          logger.logSystemEvent(
            'Competition round moved to ended state by scheduler',
            null,
            {
              roundId: round._id.toString(),
              year: round.year,
              level: round.level,
              endedAt: round.endedAt
            },
            'success',
            'update'
          ).catch(() => {});
        }
      }
    }

    // Optionally auto-close rounds that are ended and already finalized across all areas.
    const endedRounds = await CompetitionRound.find({
      status: 'ended',
      autoAdvance: true,
      stage: { $ne: 'face_to_face' }
    });
    for (const round of endedRounds) {
      const leaderboards = await AreaLeaderboard.find({
        roundId: round._id,
        level: round.level
      }).select('state');

      if (leaderboards.length === 0) {
        continue;
      }

      const allFinalized = leaderboards.every((leaderboard) =>
        ['finalized', 'published'].includes(leaderboard.state)
      );

      if (!allFinalized) {
        continue;
      }

      round.status = 'closed';
      round.closedAt = round.closedAt || now;
      await round.save();

      if (logger) {
        logger.logSystemEvent(
          'Competition round auto-closed after all areas finalized',
          null,
          {
            roundId: round._id.toString(),
            year: round.year,
            level: round.level,
            closedAt: round.closedAt
          },
          'success',
          'update'
        ).catch(() => {});
      }
    }
  } catch (error) {
    console.error('Error checking rounds:', error);
    if (logger) {
      logger.logError(
        'Error in round scheduler',
        null,
        null,
        { error: error.message },
        'error'
      ).catch(() => {});
    }
  }
};

let schedulerInterval = null;

const startScheduler = () => {
  if (schedulerInterval) {
    clearInterval(schedulerInterval);
  }

  setTimeout(() => {
    checkAndProcessRounds();
  }, 2000);

  schedulerInterval = setInterval(checkAndProcessRounds, 15 * 1000);
};

const stopScheduler = () => {
  if (schedulerInterval) {
    clearInterval(schedulerInterval);
    schedulerInterval = null;
  }
};

module.exports = {
  startScheduler,
  stopScheduler,
  checkAndProcessRounds
};
