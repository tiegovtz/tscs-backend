const express = require('express');
const { protect, authorize, authorizeNationalAdminOrSuperadmin } = require('../middleware/auth');
const { cacheMiddleware, invalidateCacheOnChange } = require('../middleware/cache');
const CompetitionRound = require('../models/CompetitionRound');
const AreaLeaderboard = require('../models/AreaLeaderboard');
const {
  listAreaLeaderboards,
  listCouncilAreaLeaderboards,
  listAvailableLocations,
  findAreaLeaderboardById,
  approveAreaLeaderboardAndPromote,
  publishAreaLeaderboard,
  reopenAreaLeaderboard,
  discoverMissingLeaderboardAreas,
  rebuildAreaLeaderboard,
  buildAreaId,
  getAreaTypeForLevel
} = require('../utils/roundJudgementService');

// Safely import logger
let logger = null;
try {
  const loggerModule = require('../utils/logger');
  logger = loggerModule.logger;
} catch (error) {
  logger = {
    logAdminAction: () => Promise.resolve(),
    logUserActivity: () => Promise.resolve()
  };
}

const router = express.Router();

router.use(protect);
router.use((req, res, next) => {
  if (req.user?.role === 'teacher') {
    return res.status(403).json({
      success: false,
      message: 'Teachers are not authorized to access leaderboard data'
    });
  }
  return next();
});

// @route   GET /api/leaderboard/available-locations
// @desc    Get available leaderboard area IDs for current filters
// @access  Private
router.get('/available-locations', cacheMiddleware(60), async (req, res) => {
  try {
    const { year, level, areaOfFocus } = req.query;

    if (!year || !level) {
      return res.status(400).json({
        success: false,
        message: 'Year and level are required'
      });
    }

    const locations = await listAvailableLocations({
      year: parseInt(year, 10),
      level,
      areaOfFocus: areaOfFocus || null,
      user: req.user
    });

    return res.json({
      success: true,
      locations,
      count: locations.length
    });
  } catch (error) {
    console.error('Get available locations error:', error);
    return res.status(500).json({
      success: false,
      message: error.message || 'Server error'
    });
  }
});

// @route   GET /api/leaderboard/council-area
// @desc    Get council leaderboards grouped by competition area
// @access  Private
router.get('/council-area', cacheMiddleware(30), async (req, res) => {
  try {
    const {
      roundId,
      year,
      state,
      region,
      council,
      areaOfFocus,
      isFinalized
    } = req.query;

    const filters = {
      level: 'Council'
    };

    if (roundId) filters.roundId = roundId;
    if (year) filters.year = parseInt(year, 10);
    if (areaOfFocus) filters.areaOfFocus = decodeURIComponent(areaOfFocus);
    if (region) filters.region = region;
    if (council) filters.council = council;

    if (!state && typeof isFinalized !== 'undefined') {
      filters.state = isFinalized === 'true' ? 'finalized' : 'provisional';
    } else if (state) {
      filters.state = state;
    }

    const result = await listCouncilAreaLeaderboards({ filters, user: req.user });

    if (logger) {
      logger.logUserActivity(
        `${req.user.role} viewed council area leaderboards`,
        req.user._id,
        req,
        {
          filters,
          count: result.leaderboards.length
        },
        'read'
      ).catch(() => {});
    }

    return res.json({
      success: true,
      level: 'Council',
      leaderboards: result.leaderboards,
      filters: result.filters,
      count: result.leaderboards.length
    });
  } catch (error) {
    console.error('Get council area leaderboards error:', error);
    return res.status(500).json({
      success: false,
      message: error.message || 'Server error'
    });
  }
});

// @route   GET /api/leaderboard
// @desc    Get area leaderboards with filters
// @access  Private
router.get('/', cacheMiddleware(30), async (req, res) => {
  try {
    const {
      roundId,
      year,
      level,
      areaType,
      areaId,
      areaOfFocus,
      state,
      chunkId,
      region,
      council,
      isFinalized
    } = req.query;

    const filters = {};
    if (roundId) filters.roundId = roundId;
    if (year) filters.year = parseInt(year, 10);
    if (level) filters.level = level;
    if (areaType) filters.areaType = areaType;
    if (areaId) filters.areaId = areaId;
    if (chunkId) filters.chunkId = chunkId;
    if (areaOfFocus) filters.areaOfFocus = decodeURIComponent(areaOfFocus);

    // Backward compatibility for legacy query shape.
    if (!filters.areaId && level === 'Council' && region && council) {
      filters.areaType = 'council';
      filters.areaId = `${region}::${council}`;
    } else if (!filters.areaId && level === 'Regional' && region) {
      filters.areaType = 'region';
      filters.areaId = region;
    }

    // Backward compatibility for finalized flag.
    if (!state && typeof isFinalized !== 'undefined') {
      filters.state = isFinalized === 'true' ? 'finalized' : 'provisional';
    } else if (state) {
      filters.state = state;
    }

    const leaderboards = (await listAreaLeaderboards({ filters, user: req.user })).map((leaderboard) => {
      const plain = leaderboard.toObject ? leaderboard.toObject() : leaderboard;
      return {
        ...plain,
        locationKey: plain.areaId,
        isFinalized: ['finalized', 'published'].includes(plain.state)
      };
    });

    if (logger) {
      logger.logUserActivity(
        `${req.user.role} viewed area leaderboards`,
        req.user._id,
        req,
        {
          filters,
          count: leaderboards.length
        },
        'read'
      ).catch(() => {});
    }

    return res.json({
      success: true,
      leaderboards,
      count: leaderboards.length
    });
  } catch (error) {
    console.error('Get leaderboards error:', error);
    return res.status(500).json({
      success: false,
      message: error.message || 'Server error'
    });
  }
});

// @route   GET /api/leaderboard/missing-areas
// @desc    Discover areas with eligible submissions but no leaderboard
// @access  Private (Superadmin)
router.get('/missing-areas', authorize('superadmin'), async (req, res) => {
  try {
    const { year, level, region, council, areaOfFocus } = req.query;

    if (!year || !level) {
      return res.status(400).json({
        success: false,
        message: 'Year and level are required'
      });
    }

    const missingAreas = await discoverMissingLeaderboardAreas({
      year: parseInt(year, 10),
      level,
      region: region || null,
      council: council || null,
      areaOfFocus: areaOfFocus ? decodeURIComponent(areaOfFocus) : null
    });

    return res.json({
      success: true,
      missingAreas,
      count: missingAreas.length
    });
  } catch (error) {
    console.error('Get missing areas error:', error);
    return res.status(500).json({
      success: false,
      message: error.message || 'Server error'
    });
  }
});

// @route   POST /api/leaderboard/build
// @desc    Build a leaderboard for a specific area that doesn't have one
// @access  Private (Superadmin)
router.post('/build', authorize('superadmin'), invalidateCacheOnChange('cache:/api/leaderboard*'), async (req, res) => {
  try {
    const { year, level, areaId, region, council } = req.body;

    if (!year || !level) {
      return res.status(400).json({
        success: false,
        message: 'Year and level are required'
      });
    }

    // Resolve areaId from region/council if not provided directly
    const resolvedAreaId = areaId || buildAreaId(level, region, council);
    if (!resolvedAreaId || resolvedAreaId.includes('unknown')) {
      return res.status(400).json({
        success: false,
        message: 'Valid areaId or region/council must be provided'
      });
    }

    // Find the anchor round for this year+level
    const round = await CompetitionRound.findOne({
      year: parseInt(year, 10),
      level
    }).sort({ createdAt: 1, _id: 1 });

    if (!round) {
      return res.status(404).json({
        success: false,
        message: `No competition round found for ${year} ${level} level. Please create a round first.`
      });
    }

    const leaderboard = await rebuildAreaLeaderboard(round._id, resolvedAreaId, {
      forceUnlocked: true
    });

    if (!leaderboard) {
      return res.status(500).json({
        success: false,
        message: 'Failed to build leaderboard. No eligible submissions found for this area.'
      });
    }

    if (logger) {
      logger.logAdminAction(
        'Superadmin manually built area leaderboard',
        req.user._id,
        req,
        {
          year: parseInt(year, 10),
          level,
          areaId: resolvedAreaId,
          entriesCount: leaderboard.entries?.length || 0,
          state: leaderboard.state
        },
        'success',
        'create'
      ).catch(() => {});
    }

    const plain = leaderboard.toObject ? leaderboard.toObject() : leaderboard;
    return res.json({
      success: true,
      message: `Leaderboard built with ${plain.entries?.length || 0} entries.`,
      leaderboard: {
        ...plain,
        locationKey: plain.areaId,
        isFinalized: ['finalized', 'published'].includes(plain.state)
      }
    });
  } catch (error) {
    console.error('Build leaderboard error:', error);
    return res.status(500).json({
      success: false,
      message: error.message || 'Server error'
    });
  }
});

// @route   GET /api/leaderboard/:id
// @desc    Get one area leaderboard by ID
// @access  Private
router.get('/:id', cacheMiddleware(30), async (req, res) => {
  try {
    const leaderboard = await findAreaLeaderboardById({
      id: req.params.id,
      user: req.user
    });

    if (!leaderboard) {
      return res.status(404).json({
        success: false,
        message: 'Leaderboard not found or not accessible'
      });
    }

    if (logger) {
      logger.logUserActivity(
        `${req.user.role} viewed area leaderboard`,
        req.user._id,
        req,
        {
          leaderboardId: leaderboard._id.toString(),
          roundId: leaderboard.roundId?.toString() || null,
          level: leaderboard.level,
          areaId: leaderboard.areaId,
          state: leaderboard.state
        },
        'read'
      ).catch(() => {});
    }

    const plainLeaderboard = leaderboard.toObject ? leaderboard.toObject() : leaderboard;

    return res.json({
      success: true,
      leaderboard: {
        ...plainLeaderboard,
        locationKey: plainLeaderboard.areaId,
        isFinalized: ['finalized', 'published'].includes(plainLeaderboard.state)
      }
    });
  } catch (error) {
    console.error('Get leaderboard error:', error);
    return res.status(500).json({
      success: false,
      message: error.message || 'Server error'
    });
  }
});

// Admin/superadmin-only operations
router.use(authorize('admin', 'superadmin'));
router.use(authorizeNationalAdminOrSuperadmin);

// @route   POST /api/leaderboard/:id/finalize
// @desc    Superadmin approval flow: finalize area leaderboard and promote by quota
// @access  Private (National Admin/Superadmin)
router.post('/:id/finalize', invalidateCacheOnChange('cache:/api/leaderboard*'), async (req, res) => {
  try {
    if (req.user.role !== 'superadmin') {
      return res.status(403).json({
        success: false,
        message: 'Only superadmin can finalize and promote leaderboard results'
      });
    }

    const leaderboard = await AreaLeaderboard.findById(req.params.id).select('roundId areaId state');
    if (!leaderboard) {
      return res.status(404).json({
        success: false,
        message: 'Leaderboard not found'
      });
    }

    let quotaOverride = null;
    if (Object.prototype.hasOwnProperty.call(req.body || {}, 'quota')) {
      const parsedQuota = Number(req.body.quota);
      if (!Number.isInteger(parsedQuota) || parsedQuota < 1) {
        return res.status(400).json({
          success: false,
          message: 'Quota must be a whole number greater than or equal to 1'
        });
      }
      quotaOverride = parsedQuota;
    }

    let scopedAreaOfFocus = null;
    if (Object.prototype.hasOwnProperty.call(req.body || {}, 'areaOfFocus')) {
      const parsedAreaOfFocus = String(req.body.areaOfFocus || '').trim();
      if (!parsedAreaOfFocus) {
        return res.status(400).json({
          success: false,
          message: 'areaOfFocus must be a non-empty string when provided'
        });
      }
      scopedAreaOfFocus = parsedAreaOfFocus;
    }

    let rankedSubmissionIds = null;
    if (Object.prototype.hasOwnProperty.call(req.body || {}, 'rankedSubmissionIds')) {
      if (!Array.isArray(req.body.rankedSubmissionIds)) {
        return res.status(400).json({
          success: false,
          message: 'rankedSubmissionIds must be an array when provided'
        });
      }

      const normalizedRankedSubmissionIds = req.body.rankedSubmissionIds
        .map((id) => String(id || '').trim())
        .filter(Boolean);

      if (normalizedRankedSubmissionIds.length === 0) {
        return res.status(400).json({
          success: false,
          message: 'rankedSubmissionIds must contain at least one submission id when provided'
        });
      }

      rankedSubmissionIds = normalizedRankedSubmissionIds;
    }

    const result = await approveAreaLeaderboardAndPromote({
      roundId: leaderboard.roundId,
      areaId: leaderboard.areaId,
      approvedBy: req.user._id,
      force: req.body.force === true,
      quotaOverride,
      areaOfFocus: scopedAreaOfFocus,
      rankedSubmissionIds
    });

    if (!result.success) {
      return res.status(result.status || 400).json({
        success: false,
        message: result.message,
        readiness: result.completion || null
      });
    }

    if (logger) {
      logger.logAdminAction(
        `${req.user.role} finalized area leaderboard`,
        req.user._id,
        req,
        {
          leaderboardId: req.params.id,
          roundId: leaderboard.roundId.toString(),
          areaId: leaderboard.areaId,
          areaOfFocus: scopedAreaOfFocus,
          promoted: result.promoted,
          eliminated: result.eliminated,
          nextLevel: result.nextLevel,
          appliedQuota: result.appliedQuota
        },
        'success',
        'update'
      ).catch(() => {});
    }

    return res.json({
      success: true,
      message: `Leaderboard finalized. ${result.promoted} promoted, ${result.eliminated} eliminated.`,
      ...result
    });
  } catch (error) {
    console.error('Finalize leaderboard error:', error);
    return res.status(500).json({
      success: false,
      message: error.message || 'Server error'
    });
  }
});

// @route   POST /api/leaderboard/:id/publish
// @desc    Publish finalized leaderboard to judges and/or teachers
// @access  Private (National Admin/Superadmin)
router.post('/:id/publish', invalidateCacheOnChange('cache:/api/leaderboard*'), async (req, res) => {
  try {
    const leaderboard = await AreaLeaderboard.findById(req.params.id).select('roundId areaId');
    if (!leaderboard) {
      return res.status(404).json({
        success: false,
        message: 'Leaderboard not found'
      });
    }

    const audiences = Array.isArray(req.body.audiences) ? req.body.audiences : [];
    const result = await publishAreaLeaderboard({
      roundId: leaderboard.roundId,
      areaId: leaderboard.areaId,
      publishedBy: req.user._id,
      audiences
    });

    if (!result.success) {
      return res.status(result.status || 400).json({
        success: false,
        message: result.message
      });
    }

    if (logger) {
      logger.logAdminAction(
        `${req.user.role} published area leaderboard`,
        req.user._id,
        req,
        {
          leaderboardId: req.params.id,
          roundId: leaderboard.roundId.toString(),
          areaId: leaderboard.areaId,
          audiences: result.leaderboard.publishedAudiences
        },
        'success',
        'update'
      ).catch(() => {});
    }

    return res.json({
      success: true,
      message: 'Leaderboard published successfully',
      leaderboard: result.leaderboard
    });
  } catch (error) {
    console.error('Publish leaderboard error:', error);
    return res.status(500).json({
      success: false,
      message: error.message || 'Server error'
    });
  }
});

// @route   POST /api/leaderboard/:id/reopen
// @desc    Reopen a finalized/published leaderboard for recalculation
// @access  Private (National Admin/Superadmin)
router.post('/:id/reopen', invalidateCacheOnChange('cache:/api/leaderboard*'), async (req, res) => {
  try {
    const leaderboard = await AreaLeaderboard.findById(req.params.id).select('roundId areaId');
    if (!leaderboard) {
      return res.status(404).json({
        success: false,
        message: 'Leaderboard not found'
      });
    }

    const result = await reopenAreaLeaderboard({
      roundId: leaderboard.roundId,
      areaId: leaderboard.areaId
    });

    if (!result.success) {
      return res.status(result.status || 400).json({
        success: false,
        message: result.message
      });
    }

    if (logger) {
      logger.logAdminAction(
        `${req.user.role} reopened area leaderboard`,
        req.user._id,
        req,
        {
          leaderboardId: req.params.id,
          roundId: leaderboard.roundId.toString(),
          areaId: leaderboard.areaId
        },
        'warning',
        'update'
      ).catch(() => {});
    }

    return res.json({
      success: true,
      message: 'Leaderboard reopened to provisional state',
      leaderboard: result.leaderboard
    });
  } catch (error) {
    console.error('Reopen leaderboard error:', error);
    return res.status(500).json({
      success: false,
      message: error.message || 'Server error'
    });
  }
});

// @route   POST /api/leaderboard/:year/:level/:areaOfFocus/advance
// @desc    Legacy compatibility wrapper (advances by areaId/locationKey)
// @access  Private (National Admin/Superadmin)
router.post('/:year/:level/:areaOfFocus/advance', invalidateCacheOnChange('cache:/api/leaderboard*'), async (req, res) => {
  try {
    if (req.user.role !== 'superadmin') {
      return res.status(403).json({
        success: false,
        message: 'Only superadmin can execute advancement approvals'
      });
    }

    const { year, level, areaOfFocus } = req.params;
    const decodedAreaOfFocus = decodeURIComponent(String(areaOfFocus || '')).trim();
    const { locationKey, global } = req.body || {};

    if (!['Council', 'Regional', 'National'].includes(level)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid level. Must be Council, Regional, or National'
      });
    }

    const yearNum = parseInt(year, 10);
    if (Number.isNaN(yearNum) || yearNum < 2000 || yearNum > 2100) {
      return res.status(400).json({
        success: false,
        message: 'Invalid year'
      });
    }

    const round = await CompetitionRound.findOne({
      year: yearNum,
      level,
      status: { $in: ['active', 'ended'] }
    }).sort({ status: -1, createdAt: -1 });

    if (!round) {
      return res.status(404).json({
        success: false,
        message: `No active or ended ${level} round found for ${yearNum}`
      });
    }

    const areasToAdvance = [];
    if (global) {
      const areaLeaderboards = await AreaLeaderboard.find({
        year: round.year,
        level: round.level
      }).select('areaId');
      areaLeaderboards.forEach((lb) => areasToAdvance.push(lb.areaId));
    } else if (locationKey) {
      areasToAdvance.push(locationKey);
    } else {
      return res.status(400).json({
        success: false,
        message: 'Please provide locationKey or set global to true'
      });
    }

    const uniqueAreas = [...new Set(areasToAdvance)];
    const results = [];

    for (const areaId of uniqueAreas) {
      const result = await approveAreaLeaderboardAndPromote({
        roundId: round._id,
        areaId,
        approvedBy: req.user._id,
        force: req.body.force === true,
        areaOfFocus: decodedAreaOfFocus || null
      });
      results.push({ areaId, ...result });
    }

    const totalPromoted = results.reduce((sum, item) => sum + (item.success ? (item.promoted || 0) : 0), 0);
    const totalEliminated = results.reduce((sum, item) => sum + (item.success ? (item.eliminated || 0) : 0), 0);
    const failed = results.filter((item) => !item.success);

    if (logger) {
      logger.logAdminAction(
        `${req.user.role} executed legacy leaderboard advance`,
        req.user._id,
        req,
        {
          year: yearNum,
          level,
          global: !!global,
          areas: uniqueAreas,
          totalPromoted,
          totalEliminated,
          failedAreas: failed.map((item) => ({ areaId: item.areaId, message: item.message }))
        },
        'success',
        'update'
      ).catch(() => {});
    }

    return res.json({
      success: failed.length === 0,
      message: failed.length === 0
        ? `Advanced ${uniqueAreas.length} area(s). ${totalPromoted} promoted, ${totalEliminated} eliminated.`
        : `Advanced with partial failures. ${totalPromoted} promoted, ${totalEliminated} eliminated.`,
      totalPromoted,
      totalEliminated,
      results
    });
  } catch (error) {
    console.error('Legacy advance submissions error:', error);
    return res.status(500).json({
      success: false,
      message: error.message || 'Server error'
    });
  }
});

module.exports = router;
