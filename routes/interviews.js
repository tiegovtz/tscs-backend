const express = require('express');
const InterviewEvaluation = require('../models/InterviewEvaluation');
const Evaluation = require('../models/Evaluation');
const Submission = require('../models/Submission');
const { protect, authorize } = require('../middleware/auth');
const { invalidateCacheOnChange } = require('../middleware/cache');
const { logger } = require('../utils/logger');
const { resolveJudgeEvaluationAuthorization } = require('../utils/judgeAssignment');
const {
  getRoundBySubmissionForEvaluation,
  refreshSubmissionAndAreaLeaderboard,
  getAreaIdFromSubmission
} = require('../utils/roundJudgementService');

const router = express.Router();

router.use(protect);
router.use((req, res, next) => {
  if (req.user?.role === 'teacher') {
    return res.status(403).json({
      success: false,
      message: 'Teachers are not authorized to access interview marks'
    });
  }
  return next();
});

router.get('/mine', authorize('judge'), async (req, res) => {
  try {
    const query = { judgeId: req.user._id };
    if (req.query?.roundId) query.roundId = req.query.roundId;
    if (req.query?.submissionId) query.submissionId = req.query.submissionId;

    const interviews = await InterviewEvaluation.find(query)
      .populate('submissionId', 'teacherName category subject level region council areaOfFocus school')
      .populate('roundId', 'year level status stage')
      .sort({ submittedAt: -1 });

    res.json({
      success: true,
      count: interviews.length,
      interviews
    });
  } catch (error) {
    console.error('Get my interview marks error:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Server error'
    });
  }
});

router.get('/submission/:submissionId', async (req, res) => {
  try {
    const query = { submissionId: req.params.submissionId };
    if (req.user.role === 'judge') {
      query.judgeId = req.user._id;
    }

    const interviews = await InterviewEvaluation.find(query)
      .populate('judgeId', 'name username')
      .populate('roundId', 'year level status stage')
      .sort({ submittedAt: -1 });

    res.json({
      success: true,
      count: interviews.length,
      interviews
    });
  } catch (error) {
    console.error('Get submission interview marks error:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Server error'
    });
  }
});

router.post('/', authorize('judge'), invalidateCacheOnChange(['cache:/api/leaderboard*', 'cache:/api/submissions*', 'cache:/api/interviews*']), async (req, res) => {
  try {
    const { submissionId, score, comments, roundId: explicitRoundId } = req.body;
    const numericScore = Number(score);

    if (!submissionId || !Number.isFinite(numericScore)) {
      return res.status(400).json({
        success: false,
        message: 'Please provide submissionId and interview score'
      });
    }

    if (numericScore < 0 || numericScore > 100) {
      return res.status(400).json({
        success: false,
        message: 'Interview score must be between 0 and 100'
      });
    }

    const submission = await Submission.findById(submissionId);
    if (!submission) {
      return res.status(404).json({
        success: false,
        message: 'Submission not found'
      });
    }

    if (submission.level !== 'National') {
      return res.status(403).json({
        success: false,
        message: 'Interview marks are only allowed at National level'
      });
    }

    const round = await getRoundBySubmissionForEvaluation(submission, {
      explicitRoundId: explicitRoundId || req.query?.roundId || null
    });
    if (!round || round.level !== 'National') {
      return res.status(403).json({
        success: false,
        message: 'No eligible National round found for this submission'
      });
    }

    if (round.status === 'archived' || round.status === 'closed') {
      return res.status(403).json({
        success: false,
        message: 'Interview marks cannot be submitted for a closed or archived round'
      });
    }

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
        message: 'You are not assigned to interview this submission for the active round.'
      });
    }

    const baseEvaluation = await Evaluation.findOne({
      roundId: round._id,
      submissionId,
      judgeId: req.user._id
    }).select('_id');

    if (!baseEvaluation) {
      return res.status(400).json({
        success: false,
        message: 'Submit the National video evaluation before entering interview marks.'
      });
    }

    const interview = await InterviewEvaluation.findOneAndUpdate(
      {
        roundId: round._id,
        submissionId,
        judgeId: req.user._id
      },
      {
        year: Number(submission.year),
        level: 'National',
        roundId: round._id,
        submissionId,
        judgeId: req.user._id,
        score: numericScore,
        comments: comments || '',
        submittedAt: new Date()
      },
      { new: true, upsert: true, runValidators: true }
    )
      .populate('submissionId', 'teacherName category subject level region council areaOfFocus')
      .populate('roundId', 'year level status stage');

    await refreshSubmissionAndAreaLeaderboard({ submissionId, roundId: round._id });

    await logger.logUserActivity(
      'Judge submitted interview marks',
      req.user._id,
      req,
      {
        interviewId: interview._id.toString(),
        roundId: round._id.toString(),
        submissionId: submissionId.toString(),
        areaId: getAreaIdFromSubmission(submission),
        score: numericScore
      },
      'create'
    );

    res.status(200).json({
      success: true,
      interview,
      round: {
        id: round._id,
        year: round.year,
        level: round.level,
        status: round.status
      }
    });
  } catch (error) {
    console.error('Submit interview marks error:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Server error'
    });
  }
});

module.exports = router;
