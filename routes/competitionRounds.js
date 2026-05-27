const express = require('express');
const CompetitionRound = require('../models/CompetitionRound');
const Submission = require('../models/Submission');
const Evaluation = require('../models/Evaluation');
const User = require('../models/User');
const SubmissionAssignment = require('../models/SubmissionAssignment');
const AreaLeaderboard = require('../models/AreaLeaderboard');
const RoundChunk = require('../models/RoundChunk');
const RoundSnapshot = require('../models/RoundSnapshot');
const { protect, authorize, authorizeNationalAdminOrSuperadmin } = require('../middleware/auth');
const { cacheMiddleware, invalidateCacheOnChange } = require('../middleware/cache');
const { emitRoundStateChange, emitLeaderboardModeChange } = require('../utils/socketManager');
const {
  activateRoundWithSnapshot,
  activateDueChunksForRound,
  getAreaReadiness,
  approveAreaLeaderboardAndPromote,
  rebuildAreaLeaderboard,
  ensureChunkAreasDoNotOverlap,
  addSubmissionToActiveRoundSnapshot,
  updateRoundSubmissionsFromScope,
  autoReassignUnassignedSubmissionsForRound
} = require('../utils/roundJudgementService');
const { manuallyAssignSubmission } = require('../utils/judgeAssignment');
const {
  getCanonicalAreaOfFocusLabel
} = require('../utils/areaOfFocus');

// Safely import logger
let logger = null;
try {
  const loggerModule = require('../utils/logger');
  logger = loggerModule.logger;
} catch (error) {
  logger = {
    logAdminAction: () => Promise.resolve(),
    logSystemEvent: () => Promise.resolve()
  };
}

const router = express.Router();

const getExpectedChunkAreaType = (level) => {
  if (level === 'Council') return 'council';
  if (level === 'Regional') return 'region';
  return null;
};

const normalizeChunkAreaToken = (value) => {
  if (value === null || value === undefined) return '';
  return String(value).trim();
};

const parseChunkAreaValue = (roundLevel, areaRaw) => {
  if (roundLevel === 'Regional') {
    const region = normalizeChunkAreaToken(
      typeof areaRaw === 'object' && areaRaw ? areaRaw.region : areaRaw
    );
    if (!region) {
      return { ok: false, message: `Invalid region "${region || areaRaw}" in chunk areas` };
    }
    return {
      ok: true,
      areaId: region
    };
  }

  if (roundLevel === 'Council') {
    if (typeof areaRaw === 'object' && areaRaw) {
      const region = normalizeChunkAreaToken(areaRaw.region);
      const council = normalizeChunkAreaToken(areaRaw.council);
      if (!region || !council) {
        return {
          ok: false,
          message: `Invalid council area "${region || ''}::${council || ''}" in chunk areas`
        };
      }
      return {
        ok: true,
        areaId: `${region}::${council}`
      };
    }

    const token = normalizeChunkAreaToken(areaRaw);
    if (!token) {
      return { ok: false, message: 'Chunk area cannot be empty' };
    }
    const [region, council] = token.split('::').map((part) => String(part || '').trim());
    if (!region || !council) {
      return { ok: false, message: `Invalid council area "${token}". Expected "Region::Council".` };
    }
    return {
      ok: true,
      areaId: `${region}::${council}`
    };
  }

  return { ok: false, message: 'Chunks are only supported for Council and Regional rounds' };
};

const normalizeChunkPayload = (roundLevel, chunks = [], roundEndTime = null) => {
  const expectedAreaType = getExpectedChunkAreaType(roundLevel);
  if (!expectedAreaType) {
    return { ok: false, message: 'Chunks are only supported for Council and Regional rounds' };
  }

  if (!Array.isArray(chunks)) {
    return { ok: false, message: 'chunks must be an array' };
  }

  const normalized = [];
  const nameSet = new Set();
  const seenAreas = new Map();

  for (let index = 0; index < chunks.length; index += 1) {
    const chunk = chunks[index] || {};
    const name = String(chunk.name || '').trim();
    if (!name) {
      return { ok: false, message: `Chunk #${index + 1} is missing a name` };
    }
    const normalizedName = name.toLowerCase();
    if (nameSet.has(normalizedName)) {
      return { ok: false, message: `Duplicate chunk name "${name}"` };
    }
    nameSet.add(normalizedName);

    const areaType = chunk.areaType || expectedAreaType;
    if (areaType !== expectedAreaType) {
      return {
        ok: false,
        message: `Chunk "${name}" has invalid areaType "${areaType}" for ${roundLevel} round`
      };
    }

    if (!Array.isArray(chunk.areas) || chunk.areas.length === 0) {
      return { ok: false, message: `Chunk "${name}" must include at least one area` };
    }

    const areas = [];
    const areaSet = new Set();
    for (const areaRaw of chunk.areas) {
      const parsed = parseChunkAreaValue(roundLevel, areaRaw);
      if (!parsed.ok) {
        return { ok: false, message: parsed.message };
      }
      if (areaSet.has(parsed.areaId)) continue;
      areaSet.add(parsed.areaId);

      if (seenAreas.has(parsed.areaId)) {
        return {
          ok: false,
          message: `Area "${parsed.areaId}" overlaps between chunks "${seenAreas.get(parsed.areaId)}" and "${name}"`
        };
      }
      seenAreas.set(parsed.areaId, name);
      areas.push(parsed.areaId);
    }

    let scheduledActivationTime = null;
    if (chunk.scheduledActivationTime) {
      const parsedDate = new Date(chunk.scheduledActivationTime);
      if (Number.isNaN(parsedDate.getTime())) {
        return { ok: false, message: `Chunk "${name}" has invalid activation time` };
      }
      if (roundEndTime) {
        const parsedEnd = new Date(roundEndTime);
        if (!Number.isNaN(parsedEnd.getTime()) && parsedDate > parsedEnd) {
          return { ok: false, message: `Chunk "${name}" activation time must be before round end time` };
        }
      }
      scheduledActivationTime = parsedDate;
    }

    let scheduledEndTime = null;
    if (chunk.scheduledEndTime) {
      const parsedEndDate = new Date(chunk.scheduledEndTime);
      if (Number.isNaN(parsedEndDate.getTime())) {
        return { ok: false, message: `Chunk "${name}" has invalid end time` };
      }
      if (roundEndTime) {
        const parsedRoundEnd = new Date(roundEndTime);
        if (!Number.isNaN(parsedRoundEnd.getTime()) && parsedEndDate > parsedRoundEnd) {
          return { ok: false, message: `Chunk "${name}" end time must be before round end time` };
        }
      }
      if (scheduledActivationTime && parsedEndDate <= scheduledActivationTime) {
        return { ok: false, message: `Chunk "${name}" end time must be after activation time` };
      }
      scheduledEndTime = parsedEndDate;
    }

    normalized.push({
      name,
      description: String(chunk.description || '').trim(),
      areaType: expectedAreaType,
      areas,
      isOptional: typeof chunk.isOptional === 'boolean' ? chunk.isOptional : true,
      isActive: typeof chunk.isActive === 'boolean' ? chunk.isActive : true,
      order: Number.isFinite(Number(chunk.order)) ? Number(chunk.order) : index,
      scheduledActivationTime,
      scheduledEndTime,
      activatedAt: chunk.activatedAt ? new Date(chunk.activatedAt) : null,
      endedAt: chunk.endedAt ? new Date(chunk.endedAt) : null
    });
  }

  return { ok: true, chunks: normalized, areaType: expectedAreaType };
};

const syncRoundChunks = async (round, userId, chunks = []) => {
  await RoundChunk.deleteMany({ roundId: round._id });
  if (!Array.isArray(chunks) || chunks.length === 0) {
    return [];
  }

  const payload = chunks.map((chunk) => ({
    ...chunk,
    roundId: round._id,
    level: round.level,
    createdBy: userId || null
  }));

  return RoundChunk.insertMany(payload, { ordered: false });
};

// All routes require authentication
router.use(protect);

// Public route for judges/stakeholders to get active rounds
router.get('/active', cacheMiddleware(60), async (req, res) => {
  try {
    const user = req.user;
    const includeFaceToFace = String(req.query.includeFaceToFace || '').toLowerCase() === 'true';
    const stageFilter = includeFaceToFace ? {} : { stage: { $ne: 'face_to_face' } };

    if (!user) {
      return res.json({
        success: true,
        count: 0,
        rounds: []
      });
    }

    let rounds = [];

    if (user.role === 'judge' && user.assignedLevel) {
      // Judges should see the latest active round for their level,
      // or latest ended round as fallback while finishing pending tasks.
      const levelRounds = await CompetitionRound.find({
        level: user.assignedLevel,
        status: { $in: ['active', 'ended'] },
        ...stageFilter
      }).sort({ createdAt: -1 });

      const activeRound = levelRounds.find((round) => round.status === 'active') || null;
      const endedRound = levelRounds.find((round) => round.status === 'ended') || null;
      rounds = activeRound ? [activeRound] : endedRound ? [endedRound] : [];
    } else if (user.role === 'stakeholder') {
      const latestActiveRound = await CompetitionRound.findOne({
        status: 'active',
        ...stageFilter
      })
        .sort({ updatedAt: -1, createdAt: -1 });
      rounds = latestActiveRound ? [latestActiveRound] : [];
    }

    res.json({
      success: true,
      count: rounds.length,
      rounds
    });
  } catch (error) {
    console.error('Get active rounds error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
});

// All other routes require superadmin or national admin (only national admin can manage rounds)
const isJudgeProgressReadRoute = (req) => (
  req.method === 'GET' && /^\/[^/]+\/(judge-progress|unassigned-dashboard)$/.test(req.path)
);

router.use((req, res, next) => {
  if (isJudgeProgressReadRoute(req)) return next();
  return authorize('superadmin', 'admin')(req, res, next);
});

router.use((req, res, next) => {
  if (isJudgeProgressReadRoute(req)) return next();
  return authorizeNationalAdminOrSuperadmin(req, res, next);
});

// @route   GET /api/competition-rounds
// @desc    Get all competition rounds
// @access  Private (Superadmin)
router.get('/', async (req, res) => {
  try {
    const { year, level, status, stage, includeFaceToFace } = req.query;
    
    let query = {};
    if (year) query.year = parseInt(year);
    if (level) query.level = level;
    if (status) query.status = status;
    if (stage) {
      query.stage = stage;
    } else if (String(includeFaceToFace || '').toLowerCase() !== 'true') {
      query.stage = { $ne: 'face_to_face' };
    }

    const rounds = await CompetitionRound.find(query)
      .populate('closedBy', 'name email')
      .sort({ year: -1, level: 1, createdAt: -1 });

    res.json({
      success: true,
      count: rounds.length,
      rounds
    });
  } catch (error) {
    console.error('Get competition rounds error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
});

// @route   GET /api/competition-rounds/:id
// @desc    Get single competition round
// @access  Private (Superadmin)
router.get('/:id', async (req, res) => {
  try {
    const round = await CompetitionRound.findById(req.params.id)
      .populate('closedBy', 'name email');

    if (!round) {
      return res.status(404).json({
        success: false,
        message: 'Competition round not found'
      });
    }

    res.json({
      success: true,
      round
    });
  } catch (error) {
    console.error('Get competition round error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
});

// @route   GET /api/competition-rounds/:id/chunks
// @desc    Get optional chunks for a round
// @access  Private (Superadmin/National admin)
router.get('/:id/chunks', async (req, res) => {
  try {
    const round = await CompetitionRound.findById(req.params.id).select('_id level');
    if (!round) {
      return res.status(404).json({
        success: false,
        message: 'Competition round not found'
      });
    }

    const chunks = await RoundChunk.find({ roundId: round._id }).sort({ order: 1, name: 1 });
    return res.json({
      success: true,
      roundId: round._id,
      level: round.level,
      chunks
    });
  } catch (error) {
    console.error('Get round chunks error:', error);
    return res.status(500).json({
      success: false,
      message: error.message || 'Server error'
    });
  }
});

// @route   POST /api/competition-rounds/:id/chunks
// @desc    Create an optional chunk for a round
// @access  Private (Superadmin/National admin)
router.post('/:id/chunks', async (req, res) => {
  try {
    const round = await CompetitionRound.findById(req.params.id).select('_id level endTime status');
    if (!round) {
      return res.status(404).json({
        success: false,
        message: 'Competition round not found'
      });
    }

    const {
      name,
      description = '',
      areaType,
      areas = [],
      isOptional = true,
      isActive = true,
      order = 0,
      scheduledActivationTime = null,
      scheduledEndTime = null
    } = req.body;
    if (!name || !Array.isArray(areas) || areas.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'name and a non-empty areas array are required'
      });
    }

    const expectedAreaType = getExpectedChunkAreaType(round.level);
    if (!expectedAreaType) {
      return res.status(400).json({
        success: false,
        message: 'Chunks are only supported for Council and Regional rounds'
      });
    }

    const normalized = normalizeChunkPayload(
      round.level,
      [{
        name,
        description,
        areaType: areaType || expectedAreaType,
        areas,
        isOptional,
        isActive,
        order,
        scheduledActivationTime,
        scheduledEndTime
      }],
      round.endTime
    );
    if (!normalized.ok) {
      return res.status(400).json({
        success: false,
        message: normalized.message
      });
    }

    const chunk = await RoundChunk.create({
      roundId: round._id,
      level: round.level,
      ...normalized.chunks[0],
      createdBy: req.user._id
    });

    const overlapCheck = await ensureChunkAreasDoNotOverlap(round._id, expectedAreaType);
    if (!overlapCheck.valid) {
      await RoundChunk.findByIdAndDelete(chunk._id);
      return res.status(400).json({
        success: false,
        message: `Chunk area overlap detected for "${overlapCheck.area}" between "${overlapCheck.existingChunk}" and "${overlapCheck.conflictingChunk}"`
      });
    }

    if (round.status === 'active') {
      await activateDueChunksForRound(round._id);
    }

    return res.status(201).json({
      success: true,
      chunk
    });
  } catch (error) {
    console.error('Create round chunk error:', error);
    return res.status(500).json({
      success: false,
      message: error.message || 'Server error'
    });
  }
});

// @route   PUT /api/competition-rounds/:id/chunks/:chunkId
// @desc    Update a chunk
// @access  Private (Superadmin/National admin)
router.put('/:id/chunks/:chunkId', async (req, res) => {
  try {
    const round = await CompetitionRound.findById(req.params.id).select('_id level endTime status');
    if (!round) {
      return res.status(404).json({
        success: false,
        message: 'Competition round not found'
      });
    }

    const chunk = await RoundChunk.findOne({
      _id: req.params.chunkId,
      roundId: round._id
    });
    if (!chunk) {
      return res.status(404).json({
        success: false,
        message: 'Chunk not found for this round'
      });
    }

    const previousValues = {
      name: chunk.name,
      description: chunk.description,
      areas: [...(chunk.areas || [])],
      scheduledActivationTime: chunk.scheduledActivationTime,
      scheduledEndTime: chunk.scheduledEndTime,
      activatedAt: chunk.activatedAt,
      endedAt: chunk.endedAt,
      isOptional: chunk.isOptional,
      isActive: chunk.isActive,
      order: chunk.order
    };

    const normalized = normalizeChunkPayload(
      round.level,
      [{
        name: typeof req.body.name !== 'undefined' ? req.body.name : chunk.name,
        description: typeof req.body.description !== 'undefined' ? req.body.description : chunk.description,
        areaType: chunk.areaType,
        areas: typeof req.body.areas !== 'undefined' ? req.body.areas : chunk.areas,
        isOptional: typeof req.body.isOptional !== 'undefined' ? req.body.isOptional : chunk.isOptional,
        isActive: typeof req.body.isActive !== 'undefined' ? req.body.isActive : chunk.isActive,
        order: typeof req.body.order !== 'undefined' ? req.body.order : chunk.order,
        scheduledActivationTime: typeof req.body.scheduledActivationTime !== 'undefined'
          ? req.body.scheduledActivationTime
          : chunk.scheduledActivationTime,
        scheduledEndTime: typeof req.body.scheduledEndTime !== 'undefined'
          ? req.body.scheduledEndTime
          : chunk.scheduledEndTime
      }],
      round.endTime
    );
    if (!normalized.ok) {
      return res.status(400).json({
        success: false,
        message: normalized.message
      });
    }

    const updatedChunk = normalized.chunks[0];
    chunk.name = updatedChunk.name;
    chunk.description = updatedChunk.description;
    chunk.areas = updatedChunk.areas;
    chunk.isOptional = updatedChunk.isOptional;
    chunk.isActive = updatedChunk.isActive;
    chunk.order = updatedChunk.order;
    chunk.scheduledActivationTime = updatedChunk.scheduledActivationTime;
    chunk.scheduledEndTime = updatedChunk.scheduledEndTime;
    await chunk.save();

    const overlapCheck = await ensureChunkAreasDoNotOverlap(round._id, chunk.areaType);
    if (!overlapCheck.valid) {
      Object.assign(chunk, previousValues);
      await chunk.save();
      return res.status(400).json({
        success: false,
        message: `Chunk area overlap detected for "${overlapCheck.area}" between "${overlapCheck.existingChunk}" and "${overlapCheck.conflictingChunk}"`
      });
    }

    if (round.status === 'active') {
      await activateDueChunksForRound(round._id);
    }

    return res.json({
      success: true,
      chunk
    });
  } catch (error) {
    console.error('Update round chunk error:', error);
    return res.status(500).json({
      success: false,
      message: error.message || 'Server error'
    });
  }
});

// @route   DELETE /api/competition-rounds/:id/chunks/:chunkId
// @desc    Delete a chunk from a round
// @access  Private (Superadmin/National admin)
router.delete('/:id/chunks/:chunkId', async (req, res) => {
  try {
    const chunk = await RoundChunk.findOneAndDelete({
      _id: req.params.chunkId,
      roundId: req.params.id
    });
    if (!chunk) {
      return res.status(404).json({
        success: false,
        message: 'Chunk not found for this round'
      });
    }

    return res.json({
      success: true,
      message: 'Chunk deleted successfully'
    });
  } catch (error) {
    console.error('Delete round chunk error:', error);
    return res.status(500).json({
      success: false,
      message: error.message || 'Server error'
    });
  }
});

// @route   POST /api/competition-rounds
// @desc    Create new competition round
// @access  Private (Superadmin)
router.post('/', async (req, res) => {
  try {
    const {
      year,
      level,
      stage,
      timingType,
      endTime,
      startTime,
      countdownDuration,
      region,
      council,
      autoAdvance,
      waitForAllJudges,
      reminderEnabled,
      reminderFrequency,
      chunking,
      chunks,
      promotionPolicy
    } = req.body;

    // Validate required fields
    if (!year || !level || !timingType) {
      return res.status(400).json({
        success: false,
        message: 'Please provide year, level, and timingType'
      });
    }

    if (timingType === 'fixed_time' && !endTime) {
      return res.status(400).json({
        success: false,
        message: 'endTime is required for fixed_time timing type'
      });
    }

    if (timingType === 'countdown' && !countdownDuration) {
      return res.status(400).json({
        success: false,
        message: 'countdownDuration is required for countdown timing type'
      });
    }

    // Calculate end time for countdown
    let actualEndTime = new Date(endTime || Date.now());
    if (timingType === 'countdown' && countdownDuration) {
      const start = startTime ? new Date(startTime) : new Date();
      actualEndTime = new Date(start.getTime() + parseInt(countdownDuration));
    }

    // National single timeline: only one draft/pending/active round per year + level.
    const normalizedStage = stage === 'face_to_face' ? 'face_to_face' : 'standard';
    const existingQuery = {
      year: parseInt(year),
      level,
      stage: normalizedStage,
      status: { $in: ['draft', 'pending', 'active'] }
    };

    const existing = await CompetitionRound.findOne(existingQuery);
    if (existing) {
      return res.status(400).json({
        success: false,
        message: 'An active, pending, or draft round already exists for this year and level'
      });
    }

    let normalizedChunks = [];
    const hasChunkPayload = Array.isArray(chunks) && chunks.length > 0;
    if (hasChunkPayload) {
      const chunkCheck = normalizeChunkPayload(level, chunks, actualEndTime);
      if (!chunkCheck.ok) {
        return res.status(400).json({
          success: false,
          message: chunkCheck.message
        });
      }
      normalizedChunks = chunkCheck.chunks;
    }

    const roundData = {
      year: parseInt(year),
      level,
      stage: normalizedStage,
      timingType,
      endTime: actualEndTime,
      startTime: startTime ? new Date(startTime) : null,
      countdownDuration: countdownDuration ? parseInt(countdownDuration) : null,
      // Location-scoped rounds are deprecated: timeline is national per level.
      region: null,
      council: null,
      autoAdvance: autoAdvance !== undefined ? autoAdvance : true,
      waitForAllJudges: waitForAllJudges !== undefined ? waitForAllJudges : true,
      reminderEnabled: reminderEnabled !== undefined ? reminderEnabled : true,
      reminderFrequency: reminderFrequency || 'daily',
      chunking: hasChunkPayload
        ? {
            enabled: true,
            areaType: getExpectedChunkAreaType(level)
          }
        : (chunking || undefined),
      promotionPolicy: promotionPolicy || undefined,
      metadata: {
        ...(req.body.metadata && typeof req.body.metadata === 'object' && !Array.isArray(req.body.metadata)
          ? req.body.metadata
          : {}),
        requestedRegion: region || null,
        requestedCouncil: council || null
      },
      status: 'draft'
    };

    const round = await CompetitionRound.create(roundData);
    if (hasChunkPayload) {
      await syncRoundChunks(round, req.user._id, normalizedChunks);
    }

    // Log round creation
    if (logger) {
      logger.logAdminAction(
        'Superadmin created competition round',
        req.user._id,
        req,
        {
          roundId: round._id.toString(),
          year: round.year,
          level: round.level,
          timingType: round.timingType,
          endTime: round.endTime
        },
        'success',
        'create'
      ).catch(() => {});
    }

    res.status(201).json({
      success: true,
      round
    });
  } catch (error) {
    console.error('Create competition round error:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Server error'
    });
  }
});

// @route   PUT /api/competition-rounds/:id
// @desc    Update competition round
// @access  Private (Superadmin)
router.put('/:id', async (req, res) => {
  try {
    const round = await CompetitionRound.findById(req.params.id);

    if (!round) {
      return res.status(404).json({
        success: false,
        message: 'Competition round not found'
      });
    }

    // Don't allow updating ended/closed rounds
    if (round.status === 'ended' || round.status === 'closed' || round.status === 'archived') {
      return res.status(400).json({
        success: false,
        message: 'Cannot update ended or closed rounds'
      });
    }

    // Update fields
    const updateData = { ...req.body };
    const hasChunksField = Array.isArray(req.body.chunks);
    let normalizedChunks = null;

    const hasLocationScopeValue = (value) =>
      typeof value !== 'undefined' && value !== null && String(value).trim() !== '';

    if (hasLocationScopeValue(updateData.region) || hasLocationScopeValue(updateData.council)) {
      return res.status(400).json({
        success: false,
        message: 'Location-scoped rounds are not supported. Use optional chunks for area grouping.'
      });
    }

    if (typeof updateData.region !== 'undefined') {
      updateData.region = null;
    }
    if (typeof updateData.council !== 'undefined') {
      updateData.council = null;
    }

    if (typeof updateData.stage !== 'undefined') {
      if (!['standard', 'face_to_face'].includes(String(updateData.stage))) {
        return res.status(400).json({
          success: false,
          message: 'Invalid stage value'
        });
      }
      updateData.stage = String(updateData.stage);
    }
    
    // Recalculate end time if timing changed
    if (updateData.timingType === 'countdown' && updateData.countdownDuration) {
      const start = updateData.startTime ? new Date(updateData.startTime) : (round.startTime || round.createdAt);
      updateData.endTime = new Date(start.getTime() + parseInt(updateData.countdownDuration));
    }

    if (hasChunksField) {
      const targetEndTime = updateData.endTime || round.endTime || null;
      if (req.body.chunks.length > 0) {
        const chunkCheck = normalizeChunkPayload(round.level, req.body.chunks, targetEndTime);
        if (!chunkCheck.ok) {
          return res.status(400).json({
            success: false,
            message: chunkCheck.message
          });
        }
        normalizedChunks = chunkCheck.chunks;
      } else {
        normalizedChunks = [];
      }

      updateData.chunking = {
        enabled: normalizedChunks.length > 0,
        areaType: normalizedChunks.length > 0 ? getExpectedChunkAreaType(round.level) : null
      };
    }
    delete updateData.chunks;

    const updatedRound = await CompetitionRound.findByIdAndUpdate(
      req.params.id,
      updateData,
      { new: true, runValidators: true }
    );

    if (hasChunksField) {
      await syncRoundChunks(updatedRound, req.user._id, normalizedChunks);
      if (updatedRound.status === 'active') {
        await activateDueChunksForRound(updatedRound._id);
      }
    }

    // Log round update
    if (logger) {
      logger.logAdminAction(
        'Superadmin updated competition round',
        req.user._id,
        req,
        {
          roundId: req.params.id,
          updatedFields: Object.keys(updateData)
        },
        undefined,
        'update'
      ).catch(() => {});
    }

    res.json({
      success: true,
      round: updatedRound
    });
  } catch (error) {
    console.error('Update competition round error:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Server error'
    });
  }
});

// @route   POST /api/competition-rounds/:id/activate
// @desc    Activate a competition round and capture all submissions currently assigned to judges
// @access  Private (Superadmin)
router.post('/:id/activate', async (req, res) => {
  try {
    const activationResult = await activateRoundWithSnapshot(req.params.id, req.user._id);
    if (!activationResult.success) {
      return res.status(activationResult.status || 400).json({
        success: false,
        message: activationResult.message
      });
    }

    const { round, snapshotSize, activeAreas, assignments, chunkSchedule } = activationResult;

    // Log activation
    if (logger) {
      logger.logAdminAction(
        'Superadmin activated competition round',
        req.user._id,
        req,
        {
          roundId: req.params.id,
          year: round.year,
          level: round.level,
          region: round.region,
          council: round.council,
          snapshotSize,
          activeAreas: activeAreas.length,
          assignments,
          chunkSchedule: chunkSchedule || null
        },
        'success',
        'update'
      ).catch(() => {});
    }

    // Emit round state change via Socket.IO
    emitRoundStateChange(round.year, round.level, {
      roundId: round._id.toString(),
      status: 'active',
      action: 'activated',
      level: round.level,
      region: round.region,
      council: round.council,
    });

    res.json({
      success: true,
      round,
      snapshotSize,
      activeAreas,
      assignments,
      chunkSchedule: chunkSchedule || null,
      message: 'Round activated. Snapshot captured for currently active chunks; scheduled chunks will activate automatically on time.'
    });
  } catch (error) {
    console.error('Activate competition round error:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Server error'
    });
  }
});

// @route   POST /api/competition-rounds/:id/close
// @desc    Close a competition round phase (leaderboard finalization remains year-level)
// @access  Private (Superadmin)
router.post('/:id/close', invalidateCacheOnChange('cache:/api/leaderboard*'), async (req, res) => {
  try {
    const round = await CompetitionRound.findById(req.params.id);

    if (!round) {
      return res.status(404).json({
        success: false,
        message: 'Competition round not found'
      });
    }

    if (round.status === 'closed') {
      return res.status(400).json({
        success: false,
        message: 'Round is already closed'
      });
    }
    const roundLeaderboards = await AreaLeaderboard.find({
      year: round.year,
      level: round.level
    }).select('areaId state');

    // Ensure area leaderboards exist for active areas in snapshot.
    if (roundLeaderboards.length === 0 && Array.isArray(round.activeAreas) && round.activeAreas.length > 0) {
      for (const area of round.activeAreas) {
        await rebuildAreaLeaderboard(round._id, area.areaId);
      }
    }

    const refreshedLeaderboards = await AreaLeaderboard.find({
      year: round.year,
      level: round.level
    }).select('areaId state totalSubmissions');
    const forceClose = req.body.force === true;

    const now = new Date();
    round.status = 'closed';
    if (!round.endedAt) {
      round.endedAt = now;
    }
    round.closedAt = now;
    round.closedBy = req.user._id;
    await round.save();

    const stats = {
      totalAreas: refreshedLeaderboards.length,
      finalizedAreas: refreshedLeaderboards.filter((leaderboard) =>
        ['finalized', 'published'].includes(leaderboard.state)
      ).length,
      publishedAreas: refreshedLeaderboards.filter((leaderboard) =>
        leaderboard.state === 'published'
      ).length,
      totalSubmissions: refreshedLeaderboards.reduce(
        (sum, leaderboard) => sum + (leaderboard.totalSubmissions || 0),
        0
      )
    };

    if (logger) {
      logger.logAdminAction(
        'Superadmin closed competition round',
        req.user._id,
        req,
        {
          roundId: req.params.id,
          year: round.year,
          level: round.level,
          stats,
          forced: forceClose
        },
        'success',
        'update'
      ).catch(() => {});
    }

    emitRoundStateChange(round.year, round.level, {
      roundId: round._id.toString(),
      status: 'closed',
      action: 'closed',
      level: round.level
    });

    res.json({
      success: true,
      round,
      statistics: stats,
      message: 'Round closed successfully'
    });
  } catch (error) {
    console.error('Close competition round error:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Server error'
    });
  }
});

// @route   GET /api/competition-rounds/:id/areas/:areaId/readiness
// @desc    Check if an area is ready for finalization (all assigned judges completed)
// @access  Private (Superadmin/National admin)
router.get('/:id/areas/:areaId/readiness', cacheMiddleware(20), async (req, res) => {
  try {
    const result = await getAreaReadiness({
      roundId: req.params.id,
      areaId: decodeURIComponent(req.params.areaId)
    });

    if (!result.success) {
      return res.status(result.status || 400).json({
        success: false,
        message: result.message
      });
    }

    return res.json({
      success: true,
      readiness: result.readiness,
      leaderboard: result.leaderboard
    });
  } catch (error) {
    console.error('Area readiness error:', error);
    return res.status(500).json({
      success: false,
      message: error.message || 'Server error'
    });
  }
});

// @route   POST /api/competition-rounds/:id/areas/:areaId/approve
// @desc    Approve area results and promote according to quota
// @access  Private (Superadmin/National admin)
router.post('/:id/areas/:areaId/approve', invalidateCacheOnChange('cache:/api/leaderboard*'), async (req, res) => {
  try {
    if (req.user.role !== 'superadmin') {
      return res.status(403).json({
        success: false,
        message: 'Only superadmin can approve area promotions'
      });
    }

    const result = await approveAreaLeaderboardAndPromote({
      roundId: req.params.id,
      areaId: decodeURIComponent(req.params.areaId),
      approvedBy: req.user._id,
      force: req.body.force === true
    });

    if (!result.success) {
      return res.status(result.status || 400).json({
        success: false,
        message: result.message,
        readiness: result.completion || null
      });
    }

    return res.json({
      success: true,
      message: `Area approved. ${result.promoted} promoted, ${result.eliminated} eliminated.`,
      ...result
    });
  } catch (error) {
    console.error('Area approval error:', error);
    return res.status(500).json({
      success: false,
      message: error.message || 'Server error'
    });
  }
});

// @route   POST /api/competition-rounds/:id/extend
// @desc    Extend a competition round's end time
// @access  Private (Superadmin)
router.post('/:id/extend', async (req, res) => {
  try {
    const { additionalTime } = req.body; // in milliseconds

    if (!additionalTime) {
      return res.status(400).json({
        success: false,
        message: 'Please provide additionalTime in milliseconds'
      });
    }

    const round = await CompetitionRound.findById(req.params.id);

    if (!round) {
      return res.status(404).json({
        success: false,
        message: 'Competition round not found'
      });
    }

    if (round.status === 'closed') {
      return res.status(400).json({
        success: false,
        message: 'Cannot extend closed round'
      });
    }

    const newEndTime = new Date(round.endTime.getTime() + parseInt(additionalTime));
    round.endTime = newEndTime;

    // Update countdown duration if it's a countdown type
    if (round.timingType === 'countdown' && round.startTime) {
      round.countdownDuration = newEndTime - round.startTime;
    }

    await round.save();

    emitRoundStateChange(round.year, round.level, {
      roundId: round._id.toString(),
      status: round.status,
      action: 'extended',
      level: round.level,
      endTime: newEndTime,
    });

    // Log extension
    if (logger) {
      logger.logAdminAction(
        'Superadmin extended competition round',
        req.user._id,
        req,
        {
          roundId: req.params.id,
          additionalTime: parseInt(additionalTime),
          newEndTime: newEndTime
        },
        undefined,
        'update'
      ).catch(() => {});
    }

    res.json({
      success: true,
      round
    });
  } catch (error) {
    console.error('Extend competition round error:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Server error'
    });
  }
});

// @route   PATCH /api/competition-rounds/:id/leaderboard-visibility
// @desc    Toggle leaderboard visibility between live and frozen
// @access  Private (Superadmin)
router.patch('/:id/leaderboard-visibility', async (req, res) => {
  try {
    const { visibility } = req.body;
    if (!['live', 'frozen'].includes(visibility)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid visibility value. Must be "live" or "frozen".'
      });
    }

    const round = await CompetitionRound.findById(req.params.id);
    if (!round) {
      return res.status(404).json({
        success: false,
        message: 'Competition round not found'
      });
    }

    round.leaderboardVisibility = visibility;

    if (visibility === 'frozen') {
      const snapshot = await AreaLeaderboard.find({
        year: round.year,
        level: round.level
      }).sort({ areaType: 1, areaId: 1 });
      round.frozenLeaderboardSnapshot = snapshot.map((leaderboard) => ({
        id: leaderboard._id.toString(),
        areaType: leaderboard.areaType,
        areaId: leaderboard.areaId,
        state: leaderboard.state,
        entries: leaderboard.entries
      }));
    } else {
      round.frozenLeaderboardSnapshot = null;
    }

    await round.save();

    emitLeaderboardModeChange(round.year, round.level, {
      roundId: round._id.toString(),
      visibility,
      level: round.level,
      region: round.region,
      council: round.council,
    });

    res.json({
      success: true,
      round,
      message: `Leaderboard visibility set to ${visibility}.`
    });
  } catch (error) {
    console.error('Update leaderboard visibility error:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Server error'
    });
  }
});

// @route   GET /api/competition-rounds/:id/submission-areas
// @desc    Get available area scopes for superadmin manual submission
// @access  Private (Superadmin)
router.get('/:id/submission-areas', authorize('superadmin'), async (req, res) => {
  try {
    const round = await CompetitionRound.findById(req.params.id).select('_id year level status');
    if (!round) {
      return res.status(404).json({ success: false, message: 'Competition round not found' });
    }
    if (round.status !== 'active') {
      return res.status(400).json({ success: false, message: 'Round must be active' });
    }
    if (!['Council', 'Regional'].includes(round.level)) {
      return res.status(400).json({ success: false, message: 'Manual additions are only supported for Council and Regional rounds' });
    }

    const teacherQuery = {
      role: 'teacher',
      status: 'active',
      isDeleted: { $ne: true }
    };

    const teachers = await User.find(teacherQuery).select('region council');
    const areaMap = new Map();
    for (const teacher of teachers) {
      if (round.level === 'Council') {
        if (!teacher.region || !teacher.council) continue;
        const areaId = `${teacher.region}::${teacher.council}`;
        if (!areaMap.has(areaId)) {
          areaMap.set(areaId, {
            areaId,
            region: teacher.region,
            council: teacher.council
          });
        }
      } else if (round.level === 'Regional') {
        if (!teacher.region) continue;
        const areaId = teacher.region;
        if (!areaMap.has(areaId)) {
          areaMap.set(areaId, {
            areaId,
            region: teacher.region,
            council: null
          });
        }
      }
    }

    res.json({
      success: true,
      scopeType: round.level === 'Council' ? 'council' : 'region',
      areas: [...areaMap.values()].sort((a, b) => a.areaId.localeCompare(b.areaId))
    });
  } catch (error) {
    console.error('Get round submission areas error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// @route   GET /api/competition-rounds/:id/teachers
// @desc    Get teachers in selected area scope for superadmin round submission
// @access  Private (Superadmin)
router.get('/:id/teachers', authorize('superadmin'), async (req, res) => {
  try {
    const { areaId } = req.query;
    if (!areaId) {
      return res.status(400).json({ success: false, message: 'areaId is required' });
    }

    const round = await CompetitionRound.findById(req.params.id).select('_id year level status');
    if (!round) {
      return res.status(404).json({ success: false, message: 'Competition round not found' });
    }
    if (round.status !== 'active') {
      return res.status(400).json({ success: false, message: 'Round must be active' });
    }
    if (!['Council', 'Regional'].includes(round.level)) {
      return res.status(400).json({ success: false, message: 'Manual additions are only supported for Council and Regional rounds' });
    }

    const query = { role: 'teacher', status: 'active', isDeleted: { $ne: true } };
    if (round.level === 'Council') {
      const [region, council] = String(areaId).split('::').map((token) => String(token || '').trim());
      if (!region || !council) {
        return res.status(400).json({ success: false, message: 'Invalid areaId for Council round. Expected "Region::Council".' });
      }
      query.region = region;
      query.council = council;
    } else {
      query.region = String(areaId).trim();
      if (!query.region) {
        return res.status(400).json({ success: false, message: 'Invalid areaId for Regional round' });
      }
    }

    const teachers = await User.find(query)
      .select('_id name email username school region council subject')
      .sort({ name: 1 });

    res.json({
      success: true,
      count: teachers.length,
      teachers
    });
  } catch (error) {
    console.error('Get round teachers error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// @route   GET /api/competition-rounds/:id/judges
// @desc    Get eligible judges in selected area/focus for superadmin round submission
// @access  Private (Superadmin)
router.get('/:id/judges', authorize('superadmin'), async (req, res) => {
  try {
    const { areaId, areaOfFocus } = req.query;
    if (!areaId) {
      return res.status(400).json({ success: false, message: 'areaId is required' });
    }

    const round = await CompetitionRound.findById(req.params.id).select('_id year level status');
    if (!round) {
      return res.status(404).json({ success: false, message: 'Competition round not found' });
    }
    if (round.status !== 'active') {
      return res.status(400).json({ success: false, message: 'Round must be active' });
    }
    if (!['Council', 'Regional'].includes(round.level)) {
      return res.status(400).json({ success: false, message: 'Judge filtering is only supported for Council and Regional rounds' });
    }

    const query = {
      role: 'judge',
      status: 'active',
      isDeleted: { $ne: true },
      assignedLevel: round.level
    };

    if (round.level === 'Council') {
      const [region, council] = String(areaId).split('::').map((token) => String(token || '').trim());
      if (!region || !council) {
        return res.status(400).json({ success: false, message: 'Invalid areaId for Council round. Expected "Region::Council".' });
      }
      query.assignedRegion = region;
      query.assignedCouncil = council;
    } else {
      const region = String(areaId || '').trim();
      if (!region) {
        return res.status(400).json({ success: false, message: 'Invalid areaId for Regional round' });
      }
      query.assignedRegion = region;
    }

    let judges = await User.find(query)
      .select('_id name email username assignedLevel assignedRegion assignedCouncil areasOfFocus')
      .sort({ name: 1 });

    const normalizedAreaOfFocus = typeof areaOfFocus === 'string' ? areaOfFocus.trim().toLowerCase() : '';
    if (normalizedAreaOfFocus) {
      judges = judges.filter((judge) =>
        Array.isArray(judge.areasOfFocus)
          && judge.areasOfFocus.some((focus) => String(focus || '').trim().toLowerCase() === normalizedAreaOfFocus)
      );
    }

    res.json({
      success: true,
      count: judges.length,
      judges
    });
  } catch (error) {
    console.error('Get round judges error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// @route   POST /api/competition-rounds/:id/submissions
// @desc    Create submission for teacher and attach to active round
// @access  Private (Superadmin)
router.post('/:id/submissions', authorize('superadmin'), invalidateCacheOnChange(['cache:/api/submissions*', 'cache:/api/competition-rounds*']), async (req, res) => {
  try {
    const round = await CompetitionRound.findById(req.params.id).select('_id year level status');
    if (!round) {
      return res.status(404).json({ success: false, message: 'Competition round not found' });
    }
    if (round.status !== 'active') {
      return res.status(400).json({ success: false, message: 'Round must be active' });
    }
    if (!['Council', 'Regional'].includes(round.level)) {
      return res.status(400).json({ success: false, message: 'Manual additions are only supported for Council and Regional rounds' });
    }

    const {
      teacherId,
      judgeId,
      category,
      class: classLevel,
      subject,
      areaOfFocus,
      videoLink,
      preferredLink,
      lessonPlanFileName,
      lessonPlanFileUrl,
      videoFileName,
      videoFileUrl,
      videoOriginalBytes,
      notes
    } = req.body || {};

    if (!teacherId || !category || !classLevel || !subject || !areaOfFocus) {
      return res.status(400).json({
        success: false,
        message: 'teacherId, category, class, subject, and areaOfFocus are required'
      });
    }

    const teacher = await User.findOne({
      _id: teacherId,
      role: 'teacher',
      status: 'active',
      isDeleted: { $ne: true }
    }).select('_id name school region council');

    if (!teacher) {
      return res.status(404).json({ success: false, message: 'Teacher not found or inactive' });
    }

    if (round.level === 'Council' && (!teacher.region || !teacher.council)) {
      return res.status(400).json({ success: false, message: 'Teacher must have both region and council for Council round' });
    }
    if (round.level === 'Regional' && !teacher.region) {
      return res.status(400).json({ success: false, message: 'Teacher must have region for Regional round' });
    }

    let selectedJudge = null;
    if (judgeId) {
      const judgeQuery = {
        _id: judgeId,
        role: 'judge',
        status: 'active',
        isDeleted: { $ne: true },
        assignedLevel: round.level
      };
      if (round.level === 'Council') {
        judgeQuery.assignedRegion = teacher.region;
        judgeQuery.assignedCouncil = teacher.council;
      } else {
        judgeQuery.assignedRegion = teacher.region;
      }

      selectedJudge = await User.findOne(judgeQuery).select('_id areasOfFocus');
      if (!selectedJudge) {
        return res.status(400).json({
          success: false,
          message: 'Selected judge is not eligible for the chosen area scope'
        });
      }

      const focusMatch = Array.isArray(selectedJudge.areasOfFocus)
        && selectedJudge.areasOfFocus.some((focus) =>
          String(focus || '').trim().toLowerCase() === String(areaOfFocus || '').trim().toLowerCase()
        );
      if (!focusMatch) {
        return res.status(400).json({
          success: false,
          message: 'Selected judge does not match the chosen area of focus'
        });
      }
    }

    const duplicate = await Submission.findOne({
      teacherId: teacher._id,
      areaOfFocus,
      year: round.year,
      isDeleted: { $ne: true }
    }).select('_id');
    if (duplicate) {
      return res.status(400).json({
        success: false,
        message: 'Teacher already has a submission for this area of focus in this year'
      });
    }

    const submissionPayload = {
      teacherId: teacher._id,
      teacherName: teacher.name,
      year: round.year,
      category,
      class: classLevel,
      subject,
      areaOfFocus,
      level: round.level,
      status: 'submitted',
      region: teacher.region,
      council: round.level === 'Council' ? teacher.council : null,
      school: teacher.school || 'N/A',
      videoLink: videoLink || '',
      preferredLink: preferredLink || '',
      lessonPlanFileName: lessonPlanFileName || '',
      lessonPlanFileUrl: lessonPlanFileUrl || '',
      videoFileName: videoFileName || '',
      videoFileUrl: videoFileUrl || '',
      videoOriginalBytes: Number.isFinite(Number(videoOriginalBytes)) ? Number(videoOriginalBytes) : undefined,
      notes: notes || ''
    };

    const submission = await Submission.create(submissionPayload);
    const attachResult = await addSubmissionToActiveRoundSnapshot(round, submission);
    if (!attachResult.success) {
      await Submission.deleteOne({ _id: submission._id });
      return res.status(attachResult.status || 400).json({
        success: false,
        message: attachResult.message || 'Failed to attach submission to round'
      });
    }

    let directAssignment = null;
    if (judgeId) {
      const directAssignmentResult = await manuallyAssignSubmission(submission._id, judgeId, { roundId: round._id });
      if (!directAssignmentResult.success) {
        return res.status(201).json({
          success: true,
          message: 'Submission added, but direct judge assignment failed. Default assignment has been kept.',
          submission,
          assignment: attachResult.assignments || { assigned: 0, unassigned: 0 },
          assignmentWarning: directAssignmentResult.error || 'Failed to assign selected judge'
        });
      }
      directAssignment = directAssignmentResult.assignment;
    }

    res.status(201).json({
      success: true,
      message: 'Submission added to active round successfully',
      submission,
      assignment: attachResult.assignments || { assigned: 0, unassigned: 0 },
      directAssignment
    });
  } catch (error) {
    console.error('Create round submission error:', error);
    res.status(500).json({ success: false, message: error.message || 'Server error' });
  }
});

// @route   POST /api/competition-rounds/:id/submissions/update
// @route   POST /api/competition-rounds/:id/update-submissions
// @desc    Backfill missing in-scope submissions into an active round and auto-assign judges
// @access  Private (Superadmin)
router.post(['/:id/submissions/update', '/:id/update-submissions'], authorize('superadmin'), invalidateCacheOnChange(['cache:/api/submissions*', 'cache:/api/competition-rounds*', 'cache:/api/leaderboard*']), async (req, res) => {
  try {
    const result = await updateRoundSubmissionsFromScope(req.params.id);
    if (!result.success) {
      return res.status(result.status || 400).json({
        success: false,
        message: result.message || 'Failed to update round submissions'
      });
    }

    if (logger) {
      logger.logAdminAction(
        'Superadmin updated active round submissions from scope',
        req.user._id,
        req,
        {
          roundId: req.params.id,
          level: result.level,
          scopeSubmissions: result.scopeSubmissions,
          existingInRound: result.existingInRound,
          addedSubmissions: result.addedSubmissions,
          assignments: result.assignments,
          chunking: result.chunking
        },
        'success',
        'update'
      ).catch(() => {});
    }

    return res.json({
      success: true,
      message: `Round submissions updated. Added ${result.addedSubmissions} submission(s) and created ${result.assignments?.assigned || 0} assignment(s).`,
      ...result
    });
  } catch (error) {
    console.error('Update round submissions from scope error:', error);
    return res.status(500).json({
      success: false,
      message: error.message || 'Server error'
    });
  }
});

// @route   GET /api/competition-rounds/:id/leaderboard
// @desc    Get area leaderboards for a competition round
// @access  Private (Superadmin)
router.get('/:id/leaderboard', async (req, res) => {
  try {
    const round = await CompetitionRound.findById(req.params.id);

    if (!round) {
      return res.status(404).json({
        success: false,
        message: 'Competition round not found'
      });
    }

    const query = {
      year: round.year,
      level: round.level
    };

    if (req.query.state) query.state = req.query.state;
    if (req.query.areaId) query.areaId = req.query.areaId;
    if (req.query.areaType) query.areaType = req.query.areaType;

    const rawLeaderboards = await AreaLeaderboard.find(query).sort({ updatedAt: -1, createdAt: -1, areaType: 1, areaId: 1 });
    const statePriority = {
      published: 4,
      finalized: 3,
      awaiting_superadmin_approval: 2,
      provisional: 1
    };
    const scopedLeaderboards = new Map();
    for (const leaderboard of rawLeaderboards) {
      const key = `${leaderboard.areaType}::${leaderboard.areaId}`;
      const existing = scopedLeaderboards.get(key);
      if (!existing) {
        scopedLeaderboards.set(key, leaderboard);
        continue;
      }

      const existingPriority = statePriority[existing.state] || 0;
      const nextPriority = statePriority[leaderboard.state] || 0;
      if (nextPriority > existingPriority) {
        scopedLeaderboards.set(key, leaderboard);
        continue;
      }
      if (nextPriority < existingPriority) {
        continue;
      }

      const existingUpdated = new Date(existing.updatedAt || existing.lastUpdated || existing.createdAt || 0).getTime();
      const nextUpdated = new Date(leaderboard.updatedAt || leaderboard.lastUpdated || leaderboard.createdAt || 0).getTime();
      if (nextUpdated >= existingUpdated) {
        scopedLeaderboards.set(key, leaderboard);
      }
    }
    const leaderboards = [...scopedLeaderboards.values()].sort((left, right) => {
      if ((left.areaType || '') !== (right.areaType || '')) {
        return String(left.areaType || '').localeCompare(String(right.areaType || ''));
      }
      return String(left.areaId || '').localeCompare(String(right.areaId || ''));
    });

    res.json({
      success: true,
      round: {
        id: round._id.toString(),
        year: round.year,
        level: round.level,
        status: round.status,
        region: round.region,
        council: round.council
      },
      leaderboards: leaderboards.map((leaderboard) => ({
        ...leaderboard.toObject(),
        locationKey: leaderboard.areaId,
        isFinalized: ['finalized', 'published'].includes(leaderboard.state)
      })),
      totalAreas: leaderboards.length
    });
  } catch (error) {
    console.error('Get leaderboard error:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Server error'
    });
  }
});

// @route   GET /api/competition-rounds/:id/judge-progress
// @desc    Get judge progress for a competition round
// @access  Private (Superadmin)
router.get('/:id/judge-progress', async (req, res) => {
  try {
    const isSuperadmin = req.user?.role === 'superadmin';
    const isNationalAdmin = req.user?.role === 'admin' && req.user?.adminLevel === 'National';
    const isStakeholder = req.user?.role === 'stakeholder';
    const canAccessJudgeProgress = isSuperadmin || isNationalAdmin || isStakeholder;

    if (!canAccessJudgeProgress) {
      return res.status(403).json({
        success: false,
        message: 'Not authorized to view judge progress'
      });
    }

    const round = await CompetitionRound.findById(req.params.id);

    if (!round) {
      return res.status(404).json({
        success: false,
        message: 'Competition round not found'
      });
    }

    if (isStakeholder) {
      const latestActiveRound = await CompetitionRound.findOne({ status: 'active' })
        .sort({ updatedAt: -1, createdAt: -1 })
        .select('_id status');

      if (!latestActiveRound || String(latestActiveRound._id) !== String(round._id)) {
        return res.status(403).json({
          success: false,
          message: 'Stakeholders can only view judge progress for the current active round'
        });
      }
    }

    const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const normalize = (value) => (value ? value.toString().trim() : '');
    const toExactRegex = (value) => {
      const normalized = normalize(value);
      return normalized ? new RegExp(`^${escapeRegExp(normalized)}$`, 'i') : null;
    };

    const requestedRegion = normalize(req.query.region);
    const requestedCouncilRaw = normalize(req.query.council);
    const requestedGroupBy = normalize(req.query.groupBy).toLowerCase();
    const requestedAreaIdRaw = normalize(req.query.areaId);
    const isCouncilRound = round.level === 'Council';
    const isNationalRound = round.level === 'National';
    const requestedCouncil = isCouncilRound ? requestedCouncilRaw : '';

    if (!isNationalRound && requestedCouncil && !requestedRegion) {
      return res.status(400).json({
        success: false,
        message: 'Council filter requires a region filter'
      });
    }

    const scopedRegion = isNationalRound
      ? ''
      : (requestedRegion || normalize(round.region));
    const scopedCouncil = isNationalRound
      ? ''
      : (isCouncilRound ? (requestedCouncil || normalize(round.council)) : '');
    const scopeRegionRegex = isNationalRound ? null : toExactRegex(scopedRegion);
    const scopeCouncilRegex = isNationalRound ? null : toExactRegex(scopedCouncil);

    const requestedGrouping = ['regions', 'councils'].includes(requestedGroupBy)
      ? requestedGroupBy
      : (scopedCouncil || scopedRegion ? 'councils' : 'regions');
    const groupBy = isNationalRound
      ? 'areas_of_focus'
      : (isCouncilRound ? requestedGrouping : 'regions');

    const getAreaOfFocusLabel = (submission) => {
      const label = getCanonicalAreaOfFocusLabel(submission?.areaOfFocus || submission?.category || '');
      return label || 'Unknown';
    };

    const normalizedRequestedAreaId = isNationalRound
      ? String(getCanonicalAreaOfFocusLabel(requestedAreaIdRaw) || requestedAreaIdRaw || '').trim().toLowerCase()
      : requestedAreaIdRaw.toLowerCase();
    const matchesRequestedArea = (areaKey) => {
      if (!requestedAreaIdRaw) return true;
      const normalizedAreaKey = String(areaKey || '').trim().toLowerCase();
      return normalizedAreaKey === normalizedRequestedAreaId;
    };

    const buildAreaKey = (submission) => {
      if (isNationalRound) {
        return getAreaOfFocusLabel(submission);
      }
      const region = submission?.region ? String(submission.region).trim() : '';
      const council = submission?.council ? String(submission.council).trim() : '';
      if (groupBy === 'councils') {
        return region && council ? `${region}::${council}` : null;
      }
      return region || null;
    };

    let snapshotSubmissionIds = Array.isArray(round.pendingSubmissionsSnapshot)
      ? round.pendingSubmissionsSnapshot
      : [];
    let snapshotDoc = null;
    if (snapshotSubmissionIds.length === 0) {
      snapshotDoc = await RoundSnapshot.findOne({ roundId: round._id }).select('submissionIds');
      snapshotSubmissionIds = snapshotDoc?.submissionIds || [];
    }
    const hasSnapshotContext = Boolean(
      round.activationSnapshotId ||
      snapshotDoc ||
      snapshotSubmissionIds.length > 0
    );
    const roundScopedSubmissionExists = hasSnapshotContext
      ? false
      : Boolean(await Submission.exists({
          roundId: round._id,
          year: round.year,
          level: round.level,
          isDeleted: { $ne: true }
        }));

    const activeRoundSubmissionStatusExclusions = ['promoted', 'eliminated', 'disqualified'];
    const submissionQuery = hasSnapshotContext
      ? {
          _id: { $in: snapshotSubmissionIds },
          year: round.year,
          level: round.level,
          status: { $nin: activeRoundSubmissionStatusExclusions },
          disqualified: { $ne: true },
          isDeleted: { $ne: true }
        }
      : roundScopedSubmissionExists
        ? {
            roundId: round._id,
            year: round.year,
            level: round.level,
            status: { $nin: activeRoundSubmissionStatusExclusions },
            disqualified: { $ne: true },
            isDeleted: { $ne: true }
          }
        : {
            year: round.year,
            level: round.level,
            status: { $nin: activeRoundSubmissionStatusExclusions },
            disqualified: { $ne: true },
            isDeleted: { $ne: true }
          };
    if (scopeRegionRegex) submissionQuery.region = scopeRegionRegex;
    if (isCouncilRound && scopeCouncilRegex) submissionQuery.council = scopeCouncilRegex;

    const allSubmissions = await Submission.find(submissionQuery);
    const allSubmissionIds = allSubmissions.map((submission) => submission._id);
    const submissionById = new Map(
      allSubmissions.map((submission) => [String(submission._id), submission])
    );

    const levelRoundIds = await CompetitionRound.find({
      year: round.year,
      level: round.level
    }).distinct('_id');
    const levelEvaluationScope = [
      {
        year: Number(round.year),
        level: round.level
      }
    ];
    if (Array.isArray(levelRoundIds) && levelRoundIds.length > 0) {
      levelEvaluationScope.push({
        roundId: { $in: levelRoundIds }
      });
    }
    const levelEvaluatedSubmissionIds = allSubmissionIds.length > 0
      ? await Evaluation.distinct('submissionId', {
          submissionId: { $in: allSubmissionIds },
          $or: levelEvaluationScope
        })
      : [];
    const levelEvaluatedSubmissionIdSet = new Set(
      levelEvaluatedSubmissionIds.map((evaluationId) => String(evaluationId))
    );

    const judgeQuery = { role: 'judge', assignedLevel: round.level, status: 'active' };
    if (!isNationalRound) {
      if (scopeCouncilRegex && scopeRegionRegex) {
        judgeQuery.assignedRegion = scopeRegionRegex;
        judgeQuery.assignedCouncil = scopeCouncilRegex;
      } else if (scopeRegionRegex) {
        judgeQuery.assignedRegion = scopeRegionRegex;
      }
    }
    const judges = await User.find(judgeQuery).select(
      '_id name email username assignedLevel assignedRegion assignedCouncil areasOfFocus'
    );

    const assignmentsRaw = allSubmissionIds.length > 0
      ? await SubmissionAssignment.find({
          roundId: round._id,
          level: round.level,
          submissionId: { $in: allSubmissionIds }
        })
          .select('submissionId judgeId assignedAt createdAt')
          .sort({ assignedAt: -1, createdAt: -1, _id: -1 })
          .lean()
      : [];

    const latestAssignmentBySubmissionId = new Map();
    const assignmentDocsForProgress = [];
    if (isNationalRound) {
      const seenPairs = new Set();
      const panelJudgeIdsBySubmission = new Map();
      const assignmentsByPanelOrder = [...assignmentsRaw].sort((a, b) => {
        const aAssignedAt = new Date(a.assignedAt || a.createdAt || 0).getTime();
        const bAssignedAt = new Date(b.assignedAt || b.createdAt || 0).getTime();
        if (aAssignedAt !== bAssignedAt) return aAssignedAt - bAssignedAt;
        const aCreatedAt = new Date(a.createdAt || a.assignedAt || 0).getTime();
        const bCreatedAt = new Date(b.createdAt || b.assignedAt || 0).getTime();
        if (aCreatedAt !== bCreatedAt) return aCreatedAt - bCreatedAt;
        return String(a._id || '').localeCompare(String(b._id || ''));
      });
      for (const assignment of assignmentsByPanelOrder) {
        const submissionId = String(assignment.submissionId);
        const judgeId = assignment.judgeId ? String(assignment.judgeId) : null;
        if (!judgeId) continue;
        const pairKey = `${submissionId}::${judgeId}`;
        if (seenPairs.has(pairKey)) continue;
        seenPairs.add(pairKey);

        if (!panelJudgeIdsBySubmission.has(submissionId)) {
          panelJudgeIdsBySubmission.set(submissionId, []);
        }
        const panelJudgeIds = panelJudgeIdsBySubmission.get(submissionId);
        if (!panelJudgeIds.includes(judgeId)) {
          if (panelJudgeIds.length >= 3) continue;
          panelJudgeIds.push(judgeId);
        }
        assignmentDocsForProgress.push(assignment);
      }
    } else {
      for (const assignment of assignmentsRaw) {
        const submissionId = String(assignment.submissionId);
        if (latestAssignmentBySubmissionId.has(submissionId)) continue;
        latestAssignmentBySubmissionId.set(submissionId, assignment);
        assignmentDocsForProgress.push(assignment);
      }
    }

    const assignedSubmissionIdsByJudge = new Map();
    const assignedJudgeIdsBySubmission = new Map();
    for (const assignment of assignmentDocsForProgress) {
      const submissionId = String(assignment.submissionId);
      const judgeId = assignment.judgeId ? String(assignment.judgeId) : null;
      if (!judgeId) continue;
      if (!assignedSubmissionIdsByJudge.has(judgeId)) {
        assignedSubmissionIdsByJudge.set(judgeId, new Set());
      }
      assignedSubmissionIdsByJudge.get(judgeId).add(submissionId);
      if (!assignedJudgeIdsBySubmission.has(submissionId)) {
        assignedJudgeIdsBySubmission.set(submissionId, new Set());
      }
      assignedJudgeIdsBySubmission.get(submissionId).add(judgeId);
    }

    const areaTotalsMap = new Map();
    for (const submission of allSubmissions) {
      const key = buildAreaKey(submission);
      if (!key) continue;
      areaTotalsMap.set(key, (areaTotalsMap.get(key) || 0) + 1);
    }

    const evaluationsForScopedSubmissions = allSubmissionIds.length > 0
      ? await Evaluation.find({
          roundId: round._id,
          level: round.level,
          submissionId: { $in: allSubmissionIds }
        })
          .select('submissionId judgeId')
          .lean()
      : [];
    const evaluatedSubmissionIdSet = new Set(
      evaluationsForScopedSubmissions.map((evaluation) => String(evaluation.submissionId))
    );
    const evaluatedSubmissionJudgePairSet = new Set(
      evaluationsForScopedSubmissions
        .filter((evaluation) => evaluation?.judgeId)
        .map((evaluation) => `${String(evaluation.submissionId)}::${String(evaluation.judgeId)}`)
    );

    const areaAssignedSubmissionSetMap = new Map();
    const areaUnassignedSetMap = new Map();
    const areaCompletedSetMap = new Map();
    const areaActiveJudgeSetMap = new Map();
    const areaTotalAssignmentsMap = new Map();
    const areaCompletedAssignmentsMap = new Map();

    const requiredNationalEvaluators = 3;

    for (const assignment of assignmentDocsForProgress) {
      const submission = submissionById.get(String(assignment.submissionId));
      if (!submission) continue;
      const areaKey = buildAreaKey(submission);
      if (!areaKey) continue;
      const judgeId = assignment.judgeId ? String(assignment.judgeId) : null;
      if (!judgeId) continue;

      if (!areaActiveJudgeSetMap.has(areaKey)) {
        areaActiveJudgeSetMap.set(areaKey, new Set());
      }
      areaActiveJudgeSetMap.get(areaKey).add(judgeId);

      areaTotalAssignmentsMap.set(areaKey, (areaTotalAssignmentsMap.get(areaKey) || 0) + 1);
      if (evaluatedSubmissionJudgePairSet.has(`${String(assignment.submissionId)}::${judgeId}`)) {
        areaCompletedAssignmentsMap.set(areaKey, (areaCompletedAssignmentsMap.get(areaKey) || 0) + 1);
      }
    }

    for (const submission of allSubmissions) {
      const areaKey = buildAreaKey(submission);
      if (!areaKey) continue;
      const submissionId = String(submission._id);
      const status = String(submission.status || '').toLowerCase();
      const assignedJudgeIds = assignedJudgeIdsBySubmission.get(submissionId) || new Set();
      const assignedCount = assignedJudgeIds.size;

      if (isNationalRound) {
        const isFullyAssigned = assignedCount >= requiredNationalEvaluators;
        if (isFullyAssigned) {
          if (!areaAssignedSubmissionSetMap.has(areaKey)) {
            areaAssignedSubmissionSetMap.set(areaKey, new Set());
          }
          areaAssignedSubmissionSetMap.get(areaKey).add(submissionId);
        } else {
          if (!areaUnassignedSetMap.has(areaKey)) {
            areaUnassignedSetMap.set(areaKey, new Set());
          }
          areaUnassignedSetMap.get(areaKey).add(submissionId);
        }

        const isComplete = isFullyAssigned
          && [...assignedJudgeIds].every((judgeId) =>
            evaluatedSubmissionJudgePairSet.has(`${submissionId}::${judgeId}`)
          );
        if (isComplete) {
          if (!areaCompletedSetMap.has(areaKey)) {
            areaCompletedSetMap.set(areaKey, new Set());
          }
          areaCompletedSetMap.get(areaKey).add(submissionId);
        }
      } else {
        const latestAssignment = latestAssignmentBySubmissionId.get(submissionId);
        const latestJudgeId = latestAssignment?.judgeId ? String(latestAssignment.judgeId) : null;
        const isAssigned = Boolean(latestJudgeId);
        const isEvaluated = levelEvaluatedSubmissionIdSet.has(submissionId)
          || submission.disqualified === true
          || status === 'disqualified'
          || status === 'evaluated';

        if (isAssigned) {
          if (!areaAssignedSubmissionSetMap.has(areaKey)) {
            areaAssignedSubmissionSetMap.set(areaKey, new Set());
          }
          areaAssignedSubmissionSetMap.get(areaKey).add(submissionId);
        } else if (!isEvaluated) {
          if (!areaUnassignedSetMap.has(areaKey)) {
            areaUnassignedSetMap.set(areaKey, new Set());
          }
          areaUnassignedSetMap.get(areaKey).add(submissionId);
        }

        if (latestJudgeId && evaluatedSubmissionJudgePairSet.has(`${submissionId}::${latestJudgeId}`)) {
          if (!areaCompletedSetMap.has(areaKey)) {
            areaCompletedSetMap.set(areaKey, new Set());
          }
          areaCompletedSetMap.get(areaKey).add(submissionId);
        }
      }
    }

    const areaAssignedMap = new Map(
      [...areaAssignedSubmissionSetMap.entries()].map(([key, submissionSet]) => [key, submissionSet.size])
    );

    const areaKeys = [...new Set([
      ...areaTotalsMap.keys(),
      ...areaAssignedMap.keys(),
      ...areaTotalAssignmentsMap.keys()
    ])];
    const areaStats = areaKeys
      .map((areaId) => {
        const totalSubmissions = areaTotalsMap.get(areaId) || 0;
        const assignedSubmissions = areaAssignedMap.get(areaId) || 0;
        const unassignedSubmissions = areaUnassignedSetMap.get(areaId)?.size || 0;
        const completedSubmissions = areaCompletedSetMap.get(areaId)?.size || 0;
        const activeJudges = areaActiveJudgeSetMap.get(areaId)?.size || 0;
        const totalAssignments = areaTotalAssignmentsMap.get(areaId) || 0;
        const completedAssignments = areaCompletedAssignmentsMap.get(areaId) || 0;
        const pendingAssignments = Math.max(totalAssignments - completedAssignments, 0);
        return {
          areaId,
          totalSubmissions,
          assignedSubmissions,
          unassignedSubmissions,
          completedSubmissions,
          activeJudges,
          totalAssignments,
          completedAssignments,
          pendingAssignments
        };
      })
      .sort((a, b) => b.totalSubmissions - a.totalSubmissions);

    const judgeProgress = await Promise.all(judges.map(async (judge) => {
      const judgeId = String(judge._id);
      const assignedIds = assignedSubmissionIdsByJudge.get(judgeId) || new Set();
      const assignedSubmissionIds = [...assignedIds];

      const evaluationQuery = {
        roundId: round._id,
        level: round.level,
        judgeId: judge._id
      };
      if (assignedSubmissionIds.length > 0) {
        evaluationQuery.submissionId = { $in: assignedSubmissionIds };
      } else {
        evaluationQuery.submissionId = { $in: [] };
      }
      const evaluations = await Evaluation.find(evaluationQuery).select('submissionId').lean();
      const evaluatedSubmissionIds = new Set(
        evaluations.map((evaluation) => String(evaluation.submissionId))
      );

      const pendingSubmissionIds = assignedSubmissionIds.filter(
        (submissionId) => !evaluatedSubmissionIds.has(submissionId)
      );

      const assignedAreaOfFocuses = [...new Set(
        assignedSubmissionIds
          .map((submissionId) => submissionById.get(submissionId))
          .filter(Boolean)
          .map((submission) => getAreaOfFocusLabel(submission))
      )].sort((a, b) => a.localeCompare(b));

      const totalAssigned = assignedSubmissionIds.length;
      const completed = totalAssigned - pendingSubmissionIds.length;
      const percentage = totalAssigned > 0 ? Math.round((completed / totalAssigned) * 100) : 0;

      return {
        judgeId,
        judgeName: judge.name,
        judgeEmail: judge.email,
        judgeUsername: judge.username,
        assignedLevel: judge.assignedLevel,
        assignedRegion: judge.assignedRegion,
        assignedCouncil: judge.assignedCouncil,
        assignedAreaOfFocuses,
        totalAssigned,
        completed,
        pending: pendingSubmissionIds.length,
        percentage,
        assignedSubmissionIds,
        pendingSubmissionIds
      };
    }));

    const judgeById = new Map(
      judges.map((judge) => [String(judge._id), judge])
    );

    let selectedAreaDetails = null;
    if (requestedAreaIdRaw) {
      const areaSubmissions = allSubmissions.filter((submission) => {
        const areaKey = buildAreaKey(submission);
        return areaKey && matchesRequestedArea(areaKey);
      });
      const areaSubmissionIds = new Set(
        areaSubmissions.map((submission) => String(submission._id))
      );

      const submissionRows = areaSubmissions
        .map((submission) => {
          const submissionId = String(submission._id);
          const assignedJudgeIds = [
            ...(assignedJudgeIdsBySubmission.get(submissionId) || new Set())
          ];
          const assignedJudges = assignedJudgeIds.map((judgeId) => {
            const judge = judgeById.get(judgeId);
            const completed = evaluatedSubmissionJudgePairSet.has(`${submissionId}::${judgeId}`);
            return {
              judgeId,
              judgeName: judge?.name || judge?.username || judge?.email || 'Unknown',
              completed
            };
          });
          const completedAssignments = assignedJudges.filter((judgeRow) => judgeRow.completed).length;
          return {
            id: submissionId,
            submissionId,
            title: submission.title || submission.topic || submission.category || submission.subject || 'Untitled',
            teacherName: submission.teacherName || submission.teacherId?.name || 'Unknown',
            school: submission.school || 'Unknown',
            status: submission.status || 'submitted',
            submittedAt: submission.submittedAt || submission.updatedAt || submission.createdAt || null,
            assignedEvaluations: assignedJudges.length,
            completedEvaluations: completedAssignments,
            assignedJudges
          };
        })
        .sort((a, b) => new Date(b.submittedAt || 0) - new Date(a.submittedAt || 0));

      const judgeRows = judgeProgress
        .map((judgeRow) => {
          const assignedInArea = (judgeRow.assignedSubmissionIds || []).filter((submissionId) =>
            areaSubmissionIds.has(String(submissionId))
          );
          if (assignedInArea.length === 0) {
            return null;
          }
          const pendingInArea = (judgeRow.pendingSubmissionIds || []).filter((submissionId) =>
            areaSubmissionIds.has(String(submissionId))
          );
          const completedInArea = Math.max(assignedInArea.length - pendingInArea.length, 0);
          return {
            judgeId: judgeRow.judgeId,
            judgeName: judgeRow.judgeName,
            judgeEmail: judgeRow.judgeEmail,
            totalAssigned: assignedInArea.length,
            completed: completedInArea,
            pending: pendingInArea.length,
            percentage: assignedInArea.length > 0
              ? Math.round((completedInArea / assignedInArea.length) * 100)
              : 0
          };
        })
        .filter(Boolean)
        .sort((a, b) => b.totalAssigned - a.totalAssigned || a.judgeName.localeCompare(b.judgeName));

      const resolvedAreaLabel = areaSubmissions.length > 0
        ? (buildAreaKey(areaSubmissions[0]) || requestedAreaIdRaw)
        : requestedAreaIdRaw;

      selectedAreaDetails = {
        areaId: resolvedAreaLabel,
        areaLabel: resolvedAreaLabel,
        totalSubmissions: submissionRows.length,
        submissions: submissionRows,
        judges: judgeRows
      };
    }

    const totalSubmissions = allSubmissions.length;
    const totalJudges = judges.length;
    const totalEvaluations = isNationalRound
      ? [...evaluatedSubmissionJudgePairSet].filter((pair) => {
          const [submissionId, judgeId] = pair.split('::');
          const assignedJudgeIds = assignedJudgeIdsBySubmission.get(submissionId);
          return Boolean(assignedJudgeIds && assignedJudgeIds.has(judgeId));
        }).length
      : (() => {
          const latestAssignedCompletedSubmissionIds = new Set();
          for (const assignment of assignmentDocsForProgress) {
            const submissionId = String(assignment.submissionId);
            const judgeId = assignment.judgeId ? String(assignment.judgeId) : null;
            if (!judgeId) continue;
            if (evaluatedSubmissionJudgePairSet.has(`${submissionId}::${judgeId}`)) {
              latestAssignedCompletedSubmissionIds.add(submissionId);
            }
          }
          return latestAssignedCompletedSubmissionIds.size;
        })();
    const averageProgress = judgeProgress.length > 0
      ? Math.round(judgeProgress.reduce((sum, judgeRow) => sum + judgeRow.percentage, 0) / judgeProgress.length)
      : 0;
    const totalAssignedSubmissions = areaStats.reduce(
      (sum, areaRow) => sum + (Number(areaRow.assignedSubmissions) || 0),
      0
    );
    const totalUnassignedSubmissions = areaStats.reduce(
      (sum, areaRow) => sum + (Number(areaRow.unassignedSubmissions) || 0),
      0
    );
    const totalAssignedEvaluations = areaStats.reduce(
      (sum, areaRow) => sum + (Number(areaRow.totalAssignments) || 0),
      0
    );
    const totalCompletedEvaluations = areaStats.reduce(
      (sum, areaRow) => sum + (Number(areaRow.completedAssignments) || 0),
      0
    );

    // Calculate actual end time for time remaining
    const getActualEndTime = () => {
      if (round.timingType === 'fixed_time') {
        return round.endTime;
      } else if (round.timingType === 'countdown' && round.countdownDuration) {
        const start = round.startTime || round.createdAt;
        return new Date(start.getTime() + round.countdownDuration);
      }
      return round.endTime;
    };

    res.json({
      success: true,
      round: {
        id: round._id.toString(),
        year: round.year,
        level: round.level,
        status: round.status,
        endTime: getActualEndTime(),
        timingType: round.timingType,
        startTime: round.startTime,
        countdownDuration: round.countdownDuration
      },
      statistics: {
        totalSubmissions,
        totalJudges,
        totalEvaluations,
        averageProgress,
        totalAssignedSubmissions,
        totalUnassignedSubmissions,
        totalAssignedEvaluations,
        totalCompletedEvaluations
      },
      judgeProgress,
      areaStats,
      selectedAreaDetails,
      assignmentSummary: {
        totalSubmissions,
        assignedSubmissions: totalAssignedSubmissions,
        unassignedSubmissions: totalUnassignedSubmissions,
        assignedEvaluations: totalAssignedEvaluations,
        completedEvaluations: totalCompletedEvaluations
      },
      locationContext: {
        groupBy,
        region: isNationalRound ? null : (scopedRegion || null),
        council: isNationalRound ? null : (isCouncilRound ? (scopedCouncil || null) : null),
        dataScope: hasSnapshotContext ? 'snapshot' : (roundScopedSubmissionExists ? 'roundId' : 'legacy-year-level')
      }
    });
  } catch (error) {
    console.error('Get judge progress error:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Server error'
    });
  }
});

// @route   GET /api/competition-rounds/:id/unassigned-dashboard
// @desc    Get unassigned dashboard distribution, children, and drilldown rows
// @access  Private (Superadmin/National Admin/Stakeholder)
router.get('/:id/unassigned-dashboard', async (req, res) => {
  try {
    const isSuperadmin = req.user?.role === 'superadmin';
    const isNationalAdmin = req.user?.role === 'admin' && req.user?.adminLevel === 'National';
    const isStakeholder = req.user?.role === 'stakeholder';
    const canAccessDashboard = isSuperadmin || isNationalAdmin || isStakeholder;

    if (!canAccessDashboard) {
      return res.status(403).json({
        success: false,
        message: 'Not authorized to view unassigned dashboard'
      });
    }

    const round = await CompetitionRound.findById(req.params.id);
    if (!round) {
      return res.status(404).json({
        success: false,
        message: 'Competition round not found'
      });
    }

    if (isStakeholder) {
      const latestActiveRound = await CompetitionRound.findOne({ status: 'active' })
        .sort({ updatedAt: -1, createdAt: -1 })
        .select('_id status');

      if (!latestActiveRound || String(latestActiveRound._id) !== String(round._id)) {
        return res.status(403).json({
          success: false,
          message: 'Stakeholders can only view unassigned dashboard for the current active round'
        });
      }
    }

    const normalize = (value) => (value ? value.toString().trim() : '');
    const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const toExactRegex = (value) => {
      const normalized = normalize(value);
      return normalized ? new RegExp(`^${escapeRegExp(normalized)}$`, 'i') : null;
    };
    const parsePositiveInt = (value, fallback) => {
      const parsed = parseInt(value, 10);
      return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
    };

    const requestedRegion = normalize(req.query.region);
    const requestedCouncilRaw = normalize(req.query.council);
    const requestedAreaOfFocus = normalize(req.query.areaOfFocus);
    const requestedGroupBy = normalize(req.query.groupBy).toLowerCase();
    const page = parsePositiveInt(req.query.page, 1);
    const limit = parsePositiveInt(req.query.limit, 20);
    const isCouncilRound = round.level === 'Council';
    const isNationalRound = round.level === 'National';
    const requestedCouncil = isCouncilRound && !isNationalRound ? requestedCouncilRaw : '';

    if (!isNationalRound && requestedCouncil && !requestedRegion) {
      return res.status(400).json({
        success: false,
        message: 'Council filter requires a region filter'
      });
    }

    const scopedRegion = isNationalRound
      ? ''
      : (requestedRegion || normalize(round.region));
    const scopedCouncil = isNationalRound
      ? ''
      : (isCouncilRound ? (requestedCouncil || normalize(round.council)) : '');
    const scopedAreaOfFocus = requestedAreaOfFocus;
    const scopeRegionRegex = isNationalRound ? null : toExactRegex(scopedRegion);
    const scopeCouncilRegex = isNationalRound ? null : toExactRegex(scopedCouncil);
    const scopeAreaOfFocusRegex = toExactRegex(scopedAreaOfFocus);
    const requestedGrouping = ['regions', 'councils', 'areas_of_focus'].includes(requestedGroupBy)
      ? requestedGroupBy
      : (scopedCouncil || scopedRegion ? 'councils' : 'regions');
    const groupBy = isNationalRound
      ? 'areas_of_focus'
      : (isCouncilRound ? requestedGrouping : 'regions');

    const buildAreaKey = (record, targetGrouping = groupBy) => {
      if (targetGrouping === 'areas_of_focus') {
        return getCanonicalAreaOfFocusLabel(record?.areaOfFocus || record?.category || '') || 'Unknown';
      }
      const region = record?.region ? String(record.region).trim() : '';
      const council = record?.council ? String(record.council).trim() : '';
      if (targetGrouping === 'councils') {
        return region && council ? `${region}::${council}` : null;
      }
      return region || null;
    };

    let snapshotSubmissionIds = Array.isArray(round.pendingSubmissionsSnapshot)
      ? round.pendingSubmissionsSnapshot
      : [];
    let snapshotDoc = null;
    if (snapshotSubmissionIds.length === 0) {
      snapshotDoc = await RoundSnapshot.findOne({ roundId: round._id }).select('submissionIds');
      snapshotSubmissionIds = snapshotDoc?.submissionIds || [];
    }
    const hasSnapshotContext = Boolean(
      round.activationSnapshotId ||
      snapshotDoc ||
      snapshotSubmissionIds.length > 0
    );
    const roundScopedSubmissionExists = hasSnapshotContext
      ? false
      : Boolean(await Submission.exists({
          roundId: round._id,
          year: round.year,
          level: round.level,
          isDeleted: { $ne: true }
        }));

    const excludedStatuses = ['evaluated', 'promoted', 'eliminated', 'disqualified'];
    const submissionQuery = hasSnapshotContext
      ? {
          _id: { $in: snapshotSubmissionIds },
          year: round.year,
          level: round.level,
          status: { $nin: excludedStatuses },
          disqualified: { $ne: true },
          isDeleted: { $ne: true }
        }
      : roundScopedSubmissionExists
        ? {
            roundId: round._id,
            year: round.year,
            level: round.level,
            status: { $nin: excludedStatuses },
            disqualified: { $ne: true },
            isDeleted: { $ne: true }
          }
        : {
            year: round.year,
            level: round.level,
            status: { $nin: excludedStatuses },
            disqualified: { $ne: true },
            isDeleted: { $ne: true }
          };
    if (scopeRegionRegex) submissionQuery.region = scopeRegionRegex;
    if (isCouncilRound && scopeCouncilRegex) submissionQuery.council = scopeCouncilRegex;
    if (scopeAreaOfFocusRegex) submissionQuery.areaOfFocus = scopeAreaOfFocusRegex;

    const allSubmissions = await Submission.find(submissionQuery).sort({ createdAt: -1 });
    let areaOfFocusOptionSource = allSubmissions;
    if (scopeAreaOfFocusRegex) {
      const optionQuery = { ...submissionQuery };
      delete optionQuery.areaOfFocus;
      areaOfFocusOptionSource = await Submission.find(optionQuery)
        .select('areaOfFocus category')
        .lean();
    }
    const allSubmissionIds = allSubmissions.map((submission) => submission._id);
    const levelRoundIds = await CompetitionRound.find({
      year: round.year,
      level: round.level
    }).distinct('_id');
    const evaluationScope = [
      {
        year: Number(round.year),
        level: round.level
      }
    ];
    if (Array.isArray(levelRoundIds) && levelRoundIds.length > 0) {
      evaluationScope.push({
        roundId: { $in: levelRoundIds }
      });
    }
    const evaluatedSubmissionIds = allSubmissionIds.length > 0
      ? await Evaluation.distinct('submissionId', {
          submissionId: { $in: allSubmissionIds },
          $or: evaluationScope
        })
      : [];
    const evaluatedSubmissionIdSet = new Set(evaluatedSubmissionIds.map((id) => String(id)));

    let unassignedSubmissions = [];
    if (isNationalRound) {
      const assignmentDocs = allSubmissionIds.length > 0
        ? await SubmissionAssignment.find({
            roundId: round._id,
            level: round.level,
            submissionId: { $in: allSubmissionIds }
          })
            .select('submissionId judgeId assignedAt createdAt')
            .sort({ assignedAt: 1, createdAt: 1, _id: 1 })
            .lean()
        : [];
      const panelJudgeIdsBySubmission = new Map();
      for (const assignment of assignmentDocs) {
        const submissionId = String(assignment.submissionId);
        const judgeId = assignment.judgeId ? String(assignment.judgeId) : null;
        if (!judgeId) continue;
        if (!panelJudgeIdsBySubmission.has(submissionId)) {
          panelJudgeIdsBySubmission.set(submissionId, []);
        }
        const panelJudgeIds = panelJudgeIdsBySubmission.get(submissionId);
        if (panelJudgeIds.includes(judgeId)) continue;
        if (panelJudgeIds.length >= 3) continue;
        panelJudgeIds.push(judgeId);
      }
      unassignedSubmissions = allSubmissions.filter((submission) => {
        const submissionId = String(submission._id);
        if (evaluatedSubmissionIdSet.has(submissionId)) return false;
        const panelJudgeIds = panelJudgeIdsBySubmission.get(submissionId) || [];
        return panelJudgeIds.length < 3;
      });
    } else {
      const historicalAssignedSubmissionIds = allSubmissionIds.length > 0
        ? await SubmissionAssignment.distinct('submissionId', {
            roundId: round._id,
            level: round.level,
            submissionId: { $in: allSubmissionIds }
          })
        : [];
      const assignedOrEvaluatedSubmissionIdSet = new Set([
        ...historicalAssignedSubmissionIds.map((id) => String(id)),
        ...evaluatedSubmissionIds.map((id) => String(id))
      ]);
      unassignedSubmissions = allSubmissions.filter(
        (submission) => !assignedOrEvaluatedSubmissionIdSet.has(String(submission._id))
      );
    }

    const areaOfFocusTotalsMap = new Map();
    for (const submission of allSubmissions) {
      const key = String(submission.areaOfFocus || submission.category || 'Unknown').trim() || 'Unknown';
      areaOfFocusTotalsMap.set(key, (areaOfFocusTotalsMap.get(key) || 0) + 1);
    }

    const areaOfFocusUnassignedMap = new Map();
    for (const submission of unassignedSubmissions) {
      const key = String(submission.areaOfFocus || submission.category || 'Unknown').trim() || 'Unknown';
      areaOfFocusUnassignedMap.set(key, (areaOfFocusUnassignedMap.get(key) || 0) + 1);
    }

    const areaOfFocusKeys = [...new Set([
      ...areaOfFocusTotalsMap.keys(),
      ...areaOfFocusUnassignedMap.keys()
    ])];
    const areaOfFocusOptions = [...new Set(
      (areaOfFocusOptionSource || [])
        .map((submission) => String(submission.areaOfFocus || submission.category || '').trim())
        .filter(Boolean)
    )].sort((a, b) => a.localeCompare(b));

    const areaOfFocusDistribution = areaOfFocusKeys
      .map((areaOfFocus) => {
        const totalSubmissions = areaOfFocusTotalsMap.get(areaOfFocus) || 0;
        const unassignedCount = areaOfFocusUnassignedMap.get(areaOfFocus) || 0;
        return {
          areaOfFocus,
          totalSubmissions,
          assignedEvaluationCount: Math.max(totalSubmissions - unassignedCount, 0),
          unassignedSubmissions: unassignedCount
        };
      })
      .sort((a, b) => b.unassignedSubmissions - a.unassignedSubmissions);

    const distributionMap = new Map();
    for (const submission of unassignedSubmissions) {
      const key = buildAreaKey(submission, groupBy);
      if (!key) continue;
      const current = distributionMap.get(key) || {
        areaId: key,
        areaLabel: groupBy === 'councils' ? (String(key).split('::')[1] || key) : key,
        unassignedSubmissions: 0
      };
      current.unassignedSubmissions += 1;
      distributionMap.set(key, current);
    }
    const distribution = [...distributionMap.values()]
      .sort((a, b) => b.unassignedSubmissions - a.unassignedSubmissions);

    const childGrouping = isNationalRound ? 'areas_of_focus' : (isCouncilRound ? 'councils' : 'regions');
    const childTotalsMap = new Map();
    for (const submission of allSubmissions) {
      const key = buildAreaKey(submission, childGrouping);
      if (!key) continue;
      childTotalsMap.set(key, (childTotalsMap.get(key) || 0) + 1);
    }

    const childUnassignedMap = new Map();
    for (const submission of unassignedSubmissions) {
      const key = buildAreaKey(submission, childGrouping);
      if (!key) continue;
      childUnassignedMap.set(key, (childUnassignedMap.get(key) || 0) + 1);
    }

    const childKeys = [...new Set([
      ...childTotalsMap.keys(),
      ...childUnassignedMap.keys()
    ])];

    const councilAdminMap = new Map();
    if (childGrouping === 'councils' && childKeys.length > 0) {
      const adminScopeClauses = childKeys.map((key) => {
        const [region, council] = String(key).split('::');
        return { adminRegion: region, adminCouncil: council };
      });
      const councilAdmins = await User.find({
        role: 'admin',
        adminLevel: 'Council',
        $or: adminScopeClauses
      }).select('name adminRegion adminCouncil');

      for (const admin of councilAdmins) {
        const key = `${String(admin.adminRegion || '').trim()}::${String(admin.adminCouncil || '').trim()}`.toLowerCase();
        if (!councilAdminMap.has(key)) {
          councilAdminMap.set(key, admin.name || null);
        }
      }
    }

    const regionalAdminMap = new Map();
    if (childGrouping === 'regions') {
      const regionSet = new Set(
        allSubmissions
          .map((submission) => String(submission.region || '').trim())
          .filter(Boolean)
      );
      if (regionSet.size > 0) {
        const regionalAdmins = await User.find({
          role: 'admin',
          adminLevel: 'Regional',
          adminRegion: { $in: [...regionSet] }
        }).select('name adminRegion');

        for (const admin of regionalAdmins) {
          const key = String(admin.adminRegion || '').trim().toLowerCase();
          if (key && !regionalAdminMap.has(key)) {
            regionalAdminMap.set(key, admin.name || null);
          }
        }
      }
    }

    const children = childKeys
      .map((key) => {
        const unassignedCount = childUnassignedMap.get(key) || 0;
        const totalCount = childTotalsMap.get(key) || 0;
        const assignedEvaluationCount = Math.max(totalCount - unassignedCount, 0);

        if (childGrouping === 'areas_of_focus') {
          return {
            areaId: key,
            areaLabel: key,
            region: null,
            council: null,
            areaOfFocus: key,
            totalSubmissions: totalCount,
            assignedEvaluationCount,
            unassignedSubmissions: unassignedCount,
            adminName: null
          };
        }

        if (childGrouping === 'councils') {
          const [region, council] = String(key).split('::');
          const adminName = councilAdminMap.get(String(key).toLowerCase()) || null;
          return {
            areaId: key,
            areaLabel: `${region} - ${council}`,
            region,
            council,
            totalSubmissions: totalCount,
            assignedEvaluationCount,
            unassignedSubmissions: unassignedCount,
            adminName
          };
        }

        const region = String(key);
        const adminName = regionalAdminMap.get(region.toLowerCase()) || null;
        return {
          areaId: key,
          areaLabel: region,
          region,
          council: null,
          totalSubmissions: totalCount,
          assignedEvaluationCount,
          unassignedSubmissions: unassignedCount,
          adminName
        };
      })
      .sort((a, b) => b.unassignedSubmissions - a.unassignedSubmissions);

    const submissionsPool = unassignedSubmissions;
    const submissionsTotal = submissionsPool.length;
    const submissionsStart = (page - 1) * limit;
    const paginatedSubmissions = submissionsPool.slice(submissionsStart, submissionsStart + limit);

    const submissionRows = paginatedSubmissions.map((submission) => ({
      _id: submission._id,
      teacherName: submission.teacherName || null,
      teacherEmail: submission.teacherEmail || null,
      school: submission.school || null,
      region: submission.region || null,
      council: submission.council || null,
      areaOfFocus: submission.areaOfFocus || submission.category || null,
      category: submission.category || null,
      subject: submission.subject || null,
      status: submission.status || null,
      roundId: round._id,
      sourceRoundId: submission.roundId || null,
      assignmentStatus: 'unassigned',
      assignedJudgeName: null,
      assignedJudgeEmail: null,
      areaAdminName: round.level === 'Council'
        ? (councilAdminMap.get(`${String(submission.region || '').trim()}::${String(submission.council || '').trim()}`.toLowerCase()) || null)
        : round.level === 'Regional'
          ? (regionalAdminMap.get(String(submission.region || '').trim().toLowerCase()) || null)
          : null,
      submittedAt: submission.submittedAt || submission.updatedAt || submission.createdAt || null,
      createdAt: submission.createdAt || null
    }));

    return res.json({
      success: true,
      round: {
        id: round._id.toString(),
        year: round.year,
        level: round.level,
        status: round.status
      },
      locationContext: {
        groupBy,
        region: isNationalRound ? null : (scopedRegion || null),
        council: isNationalRound ? null : (isCouncilRound ? (scopedCouncil || null) : null),
        areaOfFocus: scopedAreaOfFocus || null,
        dataScope: hasSnapshotContext ? 'snapshot' : (roundScopedSubmissionExists ? 'roundId' : 'legacy-year-level')
      },
      summary: {
        totalSubmissions: allSubmissions.length,
        assignedEvaluationCount: Math.max(allSubmissions.length - unassignedSubmissions.length, 0),
        totalUnassignedSubmissions: unassignedSubmissions.length
      },
      areaOfFocusOptions,
      areaOfFocusDistribution,
      distribution,
      children,
      submissions: submissionRows,
      submissionsPagination: {
        page,
        limit,
        total: submissionsTotal,
        pages: Math.ceil(submissionsTotal / limit)
      }
    });
  } catch (error) {
    console.error('Get unassigned dashboard error:', error);
    return res.status(500).json({
      success: false,
      message: error.message || 'Server error'
    });
  }
});

// @route   POST /api/competition-rounds/:id/unassigned-dashboard/auto-reassign
// @desc    Auto-assign unassigned submissions for this round using current assignment rules
// @access  Private (Superadmin/National Admin)
router.post('/:id/unassigned-dashboard/auto-reassign', invalidateCacheOnChange(['cache:/api/submissions*', 'cache:/api/competition-rounds*']), async (req, res) => {
  try {
    const isSuperadmin = req.user?.role === 'superadmin';
    const isNationalAdmin = req.user?.role === 'admin' && req.user?.adminLevel === 'National';
    if (!isSuperadmin && !isNationalAdmin) {
      return res.status(403).json({
        success: false,
        message: 'Not authorized to auto reassign unassigned submissions'
      });
    }

    const result = await autoReassignUnassignedSubmissionsForRound(req.params.id, {
      region: req.body?.region || null,
      council: req.body?.council || null,
      areaOfFocus: req.body?.areaOfFocus || null
    });

    if (!result.success) {
      return res.status(result.status || 400).json({
        success: false,
        message: result.message || 'Failed to auto reassign submissions'
      });
    }

    if (logger) {
      logger.logAdminAction(
        'Auto reassigned unassigned submissions for round',
        req.user._id,
        req,
        {
          roundId: req.params.id,
          level: result.level,
          scopedSubmissions: result.scopedSubmissions,
          eligibleForAssignment: result.eligibleForAssignment,
          assigned: result.assigned,
          remainingUnassigned: result.remainingUnassigned
        },
        'success',
        'update'
      ).catch(() => {});
    }

    return res.json({
      success: true,
      message: `Auto reassign completed. ${result.assigned} assignment(s) created.`,
      ...result
    });
  } catch (error) {
    console.error('Auto reassign unassigned submissions error:', error);
    return res.status(500).json({
      success: false,
      message: error.message || 'Server error'
    });
  }
});

// @route   GET /api/competition-rounds/:id/judge-progress/export
// @desc    Export judge progress report as CSV
// @access  Private (Superadmin)
router.get('/:id/judge-progress/export', async (req, res) => {
  try {
    const round = await CompetitionRound.findById(req.params.id);

    if (!round) {
      return res.status(404).json({
        success: false,
        message: 'Competition round not found'
      });
    }

    let snapshotSubmissionIds = Array.isArray(round.pendingSubmissionsSnapshot)
      ? round.pendingSubmissionsSnapshot
      : [];
    let snapshotDoc = null;
    if (snapshotSubmissionIds.length === 0) {
      snapshotDoc = await RoundSnapshot.findOne({ roundId: round._id }).select('submissionIds');
      snapshotSubmissionIds = snapshotDoc?.submissionIds || [];
    }
    const hasSnapshotContext = Boolean(
      round.activationSnapshotId ||
      snapshotDoc ||
      snapshotSubmissionIds.length > 0
    );
    const roundScopedSubmissionExists = hasSnapshotContext
      ? false
      : Boolean(await Submission.exists({
          roundId: round._id,
          year: round.year,
          level: round.level,
          isDeleted: { $ne: true }
        }));
    const activeRoundSubmissionStatusExclusions = ['promoted', 'eliminated', 'disqualified'];
    const submissionQuery = hasSnapshotContext
      ? {
          _id: { $in: snapshotSubmissionIds },
          year: round.year,
          level: round.level,
          status: { $nin: activeRoundSubmissionStatusExclusions },
          disqualified: { $ne: true },
          isDeleted: { $ne: true }
        }
      : roundScopedSubmissionExists
        ? {
            roundId: round._id,
            year: round.year,
            level: round.level,
            status: { $nin: activeRoundSubmissionStatusExclusions },
            disqualified: { $ne: true },
            isDeleted: { $ne: true }
          }
        : {
            year: round.year,
            level: round.level,
            status: { $nin: activeRoundSubmissionStatusExclusions },
            disqualified: { $ne: true },
            isDeleted: { $ne: true }
          };

    const allSubmissions = await Submission.find(submissionQuery);

    // Get all judges assigned to this round's level
    const judgeQuery = { role: 'judge', assignedLevel: round.level, status: 'active' };
    if (round.level === 'Council' && round.region && round.council) {
      judgeQuery.assignedRegion = round.region;
      judgeQuery.assignedCouncil = round.council;
    } else if (round.level === 'Regional' && round.region) {
      judgeQuery.assignedRegion = round.region;
    }

    const judges = await User.find(judgeQuery).select('name email username assignedLevel assignedRegion assignedCouncil areasOfFocus');

    let submissions;
    let assignedSubmissionIdsByJudge = new Map();
    if (round.level === 'Council' || round.level === 'Regional') {
      const assignmentsRaw = await SubmissionAssignment.find({
        roundId: round._id,
        level: round.level
      })
        .select('submissionId judgeId assignedAt createdAt')
        .sort({ assignedAt: -1, createdAt: -1, _id: -1 })
        .lean();

      const latestAssignments = [];
      const latestAssignmentBySubmissionId = new Map();
      for (const assignment of assignmentsRaw) {
        const submissionId = String(assignment.submissionId);
        if (!latestAssignmentBySubmissionId.has(submissionId)) {
          latestAssignmentBySubmissionId.set(submissionId, assignment);
          latestAssignments.push(assignment);
        }
      }

      const assignedSubmissionIds = latestAssignments.map((assignment) => String(assignment.submissionId));
      submissions = allSubmissions.filter((submission) => assignedSubmissionIds.includes(String(submission._id)));

      assignedSubmissionIdsByJudge = latestAssignments.reduce((map, assignment) => {
        const judgeId = assignment.judgeId ? String(assignment.judgeId) : null;
        if (!judgeId) return map;
        if (!map.has(judgeId)) map.set(judgeId, new Set());
        map.get(judgeId).add(String(assignment.submissionId));
        return map;
      }, new Map());
    } else {
      submissions = allSubmissions;
    }

    // Calculate progress for each judge
    const judgeProgress = await Promise.all(judges.map(async (judge) => {
      const evaluations = await Evaluation.find({ 
        roundId: round._id,
        level: round.level,
        judgeId: judge._id
      });
      const evaluatedSubmissionIds = evaluations.map(e => e.submissionId.toString());
      
      let assignedSubmissions;
      if (round.level === 'Council' || round.level === 'Regional') {
        const assignedIds = assignedSubmissionIdsByJudge.get(String(judge._id)) || new Set();
        assignedSubmissions = submissions.filter((submission) => assignedIds.has(String(submission._id)));
      } else {
        assignedSubmissions = submissions;
      }

      const completed = assignedSubmissions.filter(sub => 
        evaluatedSubmissionIds.includes(sub._id.toString())
      ).length;

      const total = assignedSubmissions.length;
      const percentage = total > 0 ? Math.round((completed / total) * 100) : 0;

      return {
        judgeName: judge.name,
        judgeEmail: judge.email,
        judgeUsername: judge.username,
        assignedLevel: judge.assignedLevel || '',
        assignedRegion: judge.assignedRegion || '',
        assignedCouncil: judge.assignedCouncil || '',
        totalAssigned: total,
        completed: completed,
        pending: total - completed,
        percentage: percentage
      };
    }));

    // Generate CSV
    const csvHeaders = [
      'Judge Name',
      'Email',
      'Username',
      'Assigned Level',
      'Assigned Region',
      'Assigned Council',
      'Total Assigned',
      'Completed',
      'Pending',
      'Completion Percentage (%)'
    ];

    const csvRows = judgeProgress.map(judge => [
      judge.judgeName,
      judge.judgeEmail,
      judge.judgeUsername,
      judge.assignedLevel,
      judge.assignedRegion,
      judge.assignedCouncil,
      judge.totalAssigned,
      judge.completed,
      judge.pending,
      judge.percentage
    ]);

    // Convert to CSV format
    const csvContent = [
      csvHeaders.join(','),
      ...csvRows.map(row => row.map(cell => `"${String(cell).replace(/"/g, '""')}"`).join(','))
    ].join('\n');

    // Set response headers for CSV download
    const filename = `judge-progress-round-${round._id}-${round.year}-${round.level}-${Date.now()}.csv`;
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

    // Log export
    if (logger) {
      logger.logAdminAction(
        'Superadmin exported judge progress CSV',
        req.user._id,
        req,
        {
          roundId: req.params.id,
          judgesCount: judgeProgress.length
        },
        'success',
        'read'
      ).catch(() => {});
    }

    res.send(csvContent);
  } catch (error) {
    console.error('Export judge progress error:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Server error'
    });
  }
});

// @route   POST /api/competition-rounds/:id/remind-judge/:judgeId
// @desc    Send custom reminder to a specific judge
// @access  Private (Superadmin)
router.post('/:id/remind-judge/:judgeId', async (req, res) => {
  try {
    const { id, judgeId } = req.params;
    const { message: reminderMessage } = req.body;

    if (!reminderMessage || !reminderMessage.trim()) {
      return res.status(400).json({
        success: false,
        message: 'Reminder message is required'
      });
    }

    const round = await CompetitionRound.findById(id);
    if (!round) {
      return res.status(404).json({
        success: false,
        message: 'Competition round not found'
      });
    }

    const judge = await User.findById(judgeId);
    if (!judge || judge.role !== 'judge') {
      return res.status(404).json({
        success: false,
        message: 'Judge not found'
      });
    }

    // Send reminder via notification service
    const notificationService = require('../services/notificationService');
    await notificationService.sendCustomReminder(
      judgeId,
      reminderMessage.trim(),
      {
        roundId: round._id.toString(),
        roundName: `${round.level} Level Round (${round.year})`,
        level: round.level,
        year: round.year
      }
    );

    res.json({
      success: true,
      message: 'Reminder sent successfully'
    });
  } catch (error) {
    console.error('Send judge reminder error:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Server error'
    });
  }
});

// @route   POST /api/competition-rounds/:id/remind-location
// @desc    Send custom reminder to all judges in a location
// @access  Private (Superadmin)
router.post('/:id/remind-location', async (req, res) => {
  try {
    const { id } = req.params;
    const { message: reminderMessage, region, council } = req.body;

    if (!reminderMessage || !reminderMessage.trim()) {
      return res.status(400).json({
        success: false,
        message: 'Reminder message is required'
      });
    }

    const round = await CompetitionRound.findById(id);
    if (!round) {
      return res.status(404).json({
        success: false,
        message: 'Competition round not found'
      });
    }

    // Build location query
    const locationQuery = {
      region: region || null,
      council: council || null
    };

    // Send reminder via notification service
    const notificationService = require('../services/notificationService');
    await notificationService.sendLocationReminder(
      locationQuery,
      reminderMessage.trim(),
      {
        roundId: round._id.toString(),
        roundName: `${round.level} Level Round (${round.year})`,
        level: round.level,
        year: round.year
      }
    );

    res.json({
      success: true,
      message: 'Reminder sent to all judges in the location successfully'
    });
  } catch (error) {
    console.error('Send location reminder error:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Server error'
    });
  }
});

module.exports = router;
    if (typeof updateData.stage !== 'undefined') {
      if (!['standard', 'face_to_face'].includes(updateData.stage)) {
        return res.status(400).json({
          success: false,
          message: 'Invalid stage value'
        });
      }
    }
