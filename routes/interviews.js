const express = require('express');
const InterviewEvaluation = require('../models/InterviewEvaluation');
const Evaluation = require('../models/Evaluation');
const Submission = require('../models/Submission');
const SubmissionAssignment = require('../models/SubmissionAssignment');
const { protect, authorize } = require('../middleware/auth');
const { invalidateCacheOnChange } = require('../middleware/cache');
const { logger } = require('../utils/logger');
const {
  refreshSubmissionAndAreaLeaderboard,
  getAreaIdFromSubmission,
  getNationalInterviewEligibleSubmissionIds
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

router.get('/eligible', authorize('judge'), async (req, res) => {
  try {
    const evaluations = await Evaluation.find({
      judgeId: req.user._id,
      level: 'National'
    })
      .select('submissionId roundId submittedAt')
      .sort({ submittedAt: -1, createdAt: -1, _id: -1 })
      .lean();

    const latestEvaluationBySubmission = new Map();
    for (const evaluation of evaluations) {
      const submissionId = String(evaluation.submissionId || '');
      if (!submissionId || latestEvaluationBySubmission.has(submissionId)) continue;
      latestEvaluationBySubmission.set(submissionId, evaluation);
    }

    const eligibleSubmissionIds = new Set();
    const roundIds = [
      ...new Set(
        [...latestEvaluationBySubmission.values()]
          .map((evaluation) => evaluation.roundId)
          .filter(Boolean)
          .map((roundId) => String(roundId))
      )
    ];

    for (const roundId of roundIds) {
      const roundEligibleIds = await getNationalInterviewEligibleSubmissionIds({ roundId });
      for (const submissionId of roundEligibleIds) {
        if (latestEvaluationBySubmission.has(submissionId)) {
          eligibleSubmissionIds.add(submissionId);
        }
      }
    }

    const eligibleSubmissions = eligibleSubmissionIds.size > 0
      ? await Submission.find({ _id: { $in: [...eligibleSubmissionIds] } })
        .select('_id teacherId teacherName school category class subject areaOfFocus level region council year status averageScore videoLink preferredLink videoFileName videoFileUrl lessonPlanFileName lessonPlanFileUrl createdAt')
        .populate('teacherId', 'name email')
        .lean()
      : [];

    const eligibleOrder = new Map([...eligibleSubmissionIds].map((id, index) => [id, index]));
    eligibleSubmissions.sort((a, b) => (
      (eligibleOrder.get(String(a._id)) ?? Number.MAX_SAFE_INTEGER)
      - (eligibleOrder.get(String(b._id)) ?? Number.MAX_SAFE_INTEGER)
    ));

    res.json({
      success: true,
      count: eligibleSubmissionIds.size,
      submissionIds: [...eligibleSubmissionIds],
      submissions: eligibleSubmissions
    });
  } catch (error) {
    console.error('Get eligible interview submissions error:', error);
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

    const baseEvaluationQuery = {
      submissionId,
      judgeId: req.user._id,
      level: 'National'
    };
    const resolvedRoundId = explicitRoundId || req.query?.roundId || null;
    if (resolvedRoundId) {
      baseEvaluationQuery.roundId = resolvedRoundId;
    }

    const baseEvaluation = await Evaluation.findOne(baseEvaluationQuery)
      .select('_id roundId year level submittedAt')
      .sort({ submittedAt: -1, createdAt: -1, _id: -1 });

    if (!baseEvaluation) {
      return res.status(400).json({
        success: false,
        message: 'Submit the National video evaluation before entering interview marks.'
      });
    }

    if (!baseEvaluation.roundId) {
      return res.status(400).json({
        success: false,
        message: 'The completed National evaluation is missing its round reference.'
      });
    }

    const eligibleSubmissionIds = await getNationalInterviewEligibleSubmissionIds({
      roundId: baseEvaluation.roundId
    });
    if (!eligibleSubmissionIds.has(String(submissionId))) {
      return res.status(403).json({
        success: false,
        message: 'Only the top 5 submissions in each area of competition after result 1 are eligible for interview marks.'
      });
    }

    const panelAssignment = await SubmissionAssignment.findOne({
      roundId: baseEvaluation.roundId,
      submissionId,
      judgeId: req.user._id,
      level: 'National'
    }).select('_id');
    if (!panelAssignment) {
      return res.status(403).json({
        success: false,
        message: 'Only assigned National panel judges can enter interview marks for this submission.'
      });
    }

    const interview = await InterviewEvaluation.findOneAndUpdate(
      {
        submissionId,
        judgeId: req.user._id
      },
      {
        year: Number(submission.year),
        level: 'National',
        roundId: baseEvaluation.roundId,
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

    await refreshSubmissionAndAreaLeaderboard({ submissionId, roundId: baseEvaluation.roundId });

    await logger.logUserActivity(
      'Judge submitted interview marks',
      req.user._id,
      req,
      {
        interviewId: interview._id.toString(),
        roundId: baseEvaluation.roundId.toString(),
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
        id: baseEvaluation.roundId,
        year: baseEvaluation.year || submission.year,
        level: 'National'
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
