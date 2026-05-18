const express = require('express');
const Evaluation = require('../models/Evaluation');
const Submission = require('../models/Submission');
const { protect, authorize } = require('../middleware/auth');
const { logger } = require('../utils/logger');
const { resolveJudgeEvaluationAuthorization, isJudgeAssigned } = require('../utils/judgeAssignment');
const { invalidateCacheOnChange, cacheMiddleware } = require('../middleware/cache');
const notificationService = require('../services/notificationService');
const {
  getRoundBySubmissionForEvaluation,
  refreshSubmissionAndAreaLeaderboard,
  getAreaIdFromSubmission,
  markRoundEndedIfComplete
} = require('../utils/roundJudgementService');
const { canAdminAccessSubmission } = require('../utils/adminScope');
const Competition = require('../models/Competition');
const {
  getEvaluationCriteriaFromCompetition,
  normalizeStoredCriteria,
  validateScoresAgainstCriteria
} = require('../utils/evaluationCriteria');

const router = express.Router();

router.use(protect);
router.use((req, res, next) => {
  if (req.user?.role === 'teacher') {
    return res.status(403).json({
      success: false,
      message: 'Teachers are not authorized to access evaluation details'
    });
  }
  return next();
});

/**
 * Resolve which round an evaluation should be written to.
 * Evaluations are only allowed when the submission is in an actionable round snapshot.
 */
async function resolveEvaluationRoundForJudge(submission) {
  const snapshotRound = await getRoundBySubmissionForEvaluation(submission);
  if (snapshotRound) {
    return {
      round: snapshotRound,
      source: 'snapshot'
    };
  }

  return {
    round: null,
    source: 'none'
  };
}

async function findExistingEvaluationForRound(submissionId, judgeId, roundId) {
  return Evaluation.findOne({
    submissionId,
    judgeId,
    roundId
  });
}

// @route   GET /api/evaluations
// @desc    Get evaluations with optional filters
// @access  Private
router.get('/', cacheMiddleware(15), async (req, res) => {
  try {
    const { submissionId, judgeId, roundId } = req.query;
    const query = {};

    if (submissionId) query.submissionId = submissionId;
    if (roundId) query.roundId = roundId;

    if (submissionId && req.user.role === 'admin') {
      const submission = await Submission.findById(submissionId).select('level region council');
      if (!submission) {
        return res.status(404).json({
          success: false,
          message: 'Submission not found'
        });
      }
      if (!canAdminAccessSubmission(req.user, submission)) {
        return res.status(403).json({
          success: false,
          message: 'Not authorized to access evaluations for this submission'
        });
      }
    }

    if (req.user.role === 'judge') {
      query.judgeId = req.user._id;
    } else if (judgeId) {
      query.judgeId = judgeId;
    }

    const evaluations = await Evaluation.find(query)
      .populate('submissionId', 'teacherName category subject level region council')
      .populate('judgeId', 'name username')
      .populate('roundId', 'year level status')
      .sort({ submittedAt: -1 });

    await logger.logUserActivity(
      'User viewed evaluations list',
      req.user._id,
      req,
      {
        role: req.user.role,
        filters: { submissionId, judgeId, roundId },
        count: evaluations.length
      },
      'read'
    );

    res.json({
      success: true,
      count: evaluations.length,
      evaluations
    });
  } catch (error) {
    console.error('Get evaluations error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
});

// @route   GET /api/evaluations/:id
// @desc    Get single evaluation
// @access  Private
router.get('/:id', async (req, res) => {
  try {
    const evaluation = await Evaluation.findById(req.params.id)
      .populate('submissionId')
      .populate('judgeId', 'name username')
      .populate('roundId', 'year level status');

    if (!evaluation) {
      return res.status(404).json({
        success: false,
        message: 'Evaluation not found'
      });
    }

    if (req.user.role === 'judge' && evaluation.judgeId._id.toString() !== req.user._id.toString()) {
      await logger.logSecurity(
        'Unauthorized evaluation access attempt',
        req.user._id,
        req,
        { evaluationId: req.params.id },
        'warning'
      );

      return res.status(403).json({
        success: false,
        message: 'Not authorized to access this evaluation'
      });
    }

    if (req.user.role === 'admin' && evaluation.submissionId) {
      const sub = evaluation.submissionId;
      if (!canAdminAccessSubmission(req.user, sub)) {
        return res.status(403).json({
          success: false,
          message: 'Not authorized to access this evaluation'
        });
      }
    }

    await logger.logUserActivity(
      'User viewed evaluation details',
      req.user._id,
      req,
      {
        evaluationId: evaluation._id.toString(),
        submissionId: evaluation.submissionId?._id?.toString() || null,
        judgeId: evaluation.judgeId._id.toString(),
        roundId: evaluation.roundId?._id?.toString() || null
      },
      'read'
    );

    res.json({
      success: true,
      evaluation
    });
  } catch (error) {
    console.error('Get evaluation error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
});

// @route   POST /api/evaluations
// @desc    Create/update evaluation (judge only)
// @access  Private (Judge)
router.post('/', authorize('judge'), invalidateCacheOnChange(['cache:/api/leaderboard*', 'cache:/api/submissions*']), async (req, res) => {
  try {
    const { submissionId, scores, comments } = req.body;

    if (!submissionId || !scores || typeof scores !== 'object') {
      return res.status(400).json({
        success: false,
        message: 'Please provide submissionId and scores'
      });
    }

    const submission = await Submission.findById(submissionId);
    if (!submission) {
      return res.status(404).json({
        success: false,
        message: 'Submission not found'
      });
    }

    const { round } = await resolveEvaluationRoundForJudge(submission);
    if (!round) {
      return res.status(403).json({
        success: false,
        message: 'No eligible round found for this submission. It must be in an active or ended round snapshot.'
      });
    }

    const existingEvaluation = await findExistingEvaluationForRound(
      submission._id,
      req.user._id,
      round._id
    );

    const isRoundActive = round.status === 'active';

    if (round.status === 'archived') {
      return res.status(403).json({
        success: false,
        message: 'Round is archived. Evaluations are not allowed.'
      });
    }

    if (!existingEvaluation && round.status === 'closed') {
      return res.status(403).json({
        success: false,
        message: 'Round is closed. New evaluations are not allowed.'
      });
    }

    const now = new Date();
    const roundEndTime = typeof round.getActualEndTime === 'function'
      ? round.getActualEndTime()
      : round.endTime;

    // Keep evaluation open after endTime only when waiting for all judges (to avoid deadlock).
    if (round.status === 'active' && roundEndTime && now >= roundEndTime && !round.waitForAllJudges) {
      return res.status(403).json({
        success: false,
        message: 'Cannot evaluate submission. Round has ended.'
      });
    }

    if (['Council', 'Regional', 'National'].includes(submission.level)) {
      const authorization = await resolveJudgeEvaluationAuthorization(
        submissionId,
        req.user._id,
        round._id,
        { allowVisibleAssignmentFallback: false }
      );

      if (!authorization.success) {
        return res.status(500).json({
          success: false,
          message: authorization.error || 'Failed to verify judge assignment authorization'
        });
      }

      if (!authorization.authorized) {
        return res.status(403).json({
          success: false,
          message: 'You are not assigned to evaluate this submission for the active round.'
        });
      }
    }

    // Judges can only edit previously submitted evaluations while the round is active.
    if (existingEvaluation && !isRoundActive) {
      return res.status(403).json({
        success: false,
        message: 'You can only edit an evaluation while the round is active.'
      });
    }

    const competition = await Competition.findOne({ year: submission.year });
    const rawCriteria = getEvaluationCriteriaFromCompetition(
      competition,
      submission.category,
      submission.class,
      submission.subject,
      submission.areaOfFocus
    );
    if (!rawCriteria || rawCriteria.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'No evaluation criteria configured for this competition area'
      });
    }

    const rawArr = Array.isArray(rawCriteria)
      ? rawCriteria.map((x) => (x && typeof x.toObject === 'function' ? x.toObject() : { ...x }))
      : [];
    const criteriaNorm = normalizeStoredCriteria(rawArr);

    const scoresPlain = { ...scores };
    const verdict = validateScoresAgainstCriteria(scoresPlain, criteriaNorm);
    if (!verdict.ok) {
      return res.status(400).json({
        success: false,
        message: verdict.message
      });
    }

    const totalScore = verdict.totalScore;
    const averageScore = verdict.averageScore;
    const evaluationFilter = existingEvaluation
      ? { _id: existingEvaluation._id }
      : {
          submissionId,
          judgeId: req.user._id,
          roundId: round._id
        };

    const evaluation = await Evaluation.findOneAndUpdate(
      evaluationFilter,
      {
        year: Number(submission.year),
        level: submission.level,
        roundId: round._id,
        submissionId,
        judgeId: req.user._id,
        scores,
        totalScore,
        averageScore,
        comments: comments || '',
        submittedAt: new Date()
      },
      { new: true, upsert: !existingEvaluation, runValidators: true }
    )
      .populate('submissionId', 'teacherName category subject level region council')
      .populate('roundId', 'year level status');

    await refreshSubmissionAndAreaLeaderboard({ submissionId, roundId: round._id });
    await markRoundEndedIfComplete(round._id);

    const areaId = getAreaIdFromSubmission(submission);

    await logger.logUserActivity(
      existingEvaluation ? 'Judge updated evaluation' : 'Judge submitted evaluation',
      req.user._id,
      req,
      {
        evaluationId: evaluation._id.toString(),
        roundId: round._id.toString(),
        submissionId: submissionId.toString(),
        areaId,
        averageScore,
        totalScore,
        criteriaCount: Object.keys(scores).length
      },
      existingEvaluation ? 'update' : 'create'
    );

    res.status(existingEvaluation ? 200 : 201).json({
      success: true,
      evaluation,
      round: {
        id: round._id,
        year: round.year,
        level: round.level,
        status: round.status
      }
    });
  } catch (error) {
    console.error('Create evaluation error:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Server error'
    });
  }
});

// @route   GET /api/evaluations/submission/:submissionId
// @desc    Get all evaluations for a submission
// @access  Private
router.get('/submission/:submissionId', async (req, res) => {
  try {
    const submission = await Submission.findById(req.params.submissionId).select('_id level region council');
    if (!submission) {
      return res.status(404).json({
        success: false,
        message: 'Submission not found'
      });
    }

    if (req.user.role === 'admin' && !canAdminAccessSubmission(req.user, submission)) {
      return res.status(403).json({
        success: false,
        message: 'Not authorized to access evaluations for this submission'
      });
    }

    const query = { submissionId: req.params.submissionId };
    if (req.user.role === 'judge') {
      query.judgeId = req.user._id;
    }

    const evaluations = await Evaluation.find(query)
      .populate('judgeId', 'name username assignedLevel')
      .populate('roundId', 'year level status')
      .sort({ submittedAt: -1 });

    await logger.logUserActivity(
      'User viewed submission evaluations',
      req.user._id,
      req,
      {
        submissionId: req.params.submissionId,
        count: evaluations.length
      },
      'read'
    );

    res.json({
      success: true,
      count: evaluations.length,
      evaluations
    });
  } catch (error) {
    console.error('Get submission evaluations error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
});

// @route   POST /api/evaluations/:submissionId/disqualify
// @desc    Flag a submission for disqualification (judge only)
// @access  Private (Judge)
router.post('/:submissionId/disqualify', authorize('judge'), async (req, res) => {
  try {
    const { submissionId } = req.params;
    const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim() : '';

    if (!reason) {
      return res.status(400).json({
        success: false,
        message: 'Disqualification reason is required'
      });
    }

    const submission = await Submission.findById(submissionId);
    if (!submission) {
      return res.status(404).json({
        success: false,
        message: 'Submission not found'
      });
    }

    if (!['Council', 'Regional'].includes(submission.level)) {
      return res.status(403).json({
        success: false,
        message: 'Disqualification is only allowed at Council and Regional levels'
      });
    }

    const { round } = await resolveEvaluationRoundForJudge(submission);
    if (!round) {
      return res.status(400).json({
        success: false,
        message: 'No eligible round found for this submission'
      });
    }

    const assigned = await isJudgeAssigned(submissionId, req.user._id, round._id);
    if (!assigned) {
      return res.status(403).json({
        success: false,
        message: 'You are not assigned to evaluate this submission'
      });
    }

    submission.disqualified = true;
    submission.status = 'disqualified';
    submission.disqualificationReason = reason;
    submission.disqualifiedBy = req.user._id;
    submission.disqualifiedAt = new Date();
    await submission.save();

    const areaId = getAreaIdFromSubmission(submission);
    await refreshSubmissionAndAreaLeaderboard({ submissionId, roundId: round._id });
    await markRoundEndedIfComplete(round._id);

    if (submission.teacherId) {
      notificationService.emit('SUBMISSION_DISQUALIFIED', {
        userId: submission.teacherId,
        submissionId: submission._id,
        roundName: `${round.level} ${round.year}`,
        reason,
        subject: submission.subject,
        category: submission.category,
        areaOfFocus: submission.areaOfFocus
      }).catch((notifyError) => {
        console.error('Failed to send disqualification notification/email:', notifyError);
      });
    }

    await logger.logUserActivity(
      'Judge disqualified submission',
      req.user._id,
      req,
      {
        roundId: round._id.toString(),
        submissionId: submissionId.toString(),
        areaId,
        reason,
        level: submission.level
      },
      'update'
    );

    res.json({
      success: true,
      message: 'Submission has been flagged for disqualification',
      submission
    });
  } catch (error) {
    console.error('Disqualify submission error:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Server error'
    });
  }
});

module.exports = router;
