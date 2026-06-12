const express = require('express');
const InterviewEvaluation = require('../models/InterviewEvaluation');
const Evaluation = require('../models/Evaluation');
const Submission = require('../models/Submission');
const InterviewAssignment = require('../models/InterviewAssignment');
const User = require('../models/User');
const { protect, authorize } = require('../middleware/auth');
const { invalidateCacheOnChange } = require('../middleware/cache');
const { logger } = require('../utils/logger');
const {
  refreshSubmissionAndAreaLeaderboard,
  getAreaIdFromSubmission,
  getNationalInterviewEligibleSubmissionIds
} = require('../utils/roundJudgementService');
const { normalizeAreaOfFocus, matchesAreaOfFocus } = require('../utils/areaOfFocus');

const router = express.Router();
const NATIONAL_INTERVIEW_PANEL_SIZE = 3;

const serializeInterviewAssignment = (assignment) => ({
  assignmentId: assignment._id,
  judgeId: assignment.judgeId?._id || assignment.judgeId,
  judgeName: assignment.judgeId?.name || 'Unknown Judge',
  judgeEmail: assignment.judgeId?.email || assignment.judgeId?.username || '',
  assignedAt: assignment.assignedAt,
  roundId: assignment.roundId?._id || assignment.roundId || null,
  roundStatus: assignment.roundId?.status || null,
  roundStage: 'interview'
});

const findLatestNationalRoundIdForSubmission = async (submissionId, explicitRoundId = null) => {
  if (explicitRoundId) return explicitRoundId;

  const latestEvaluation = await Evaluation.findOne({
    submissionId,
    level: 'National'
  })
    .select('roundId submittedAt createdAt')
    .sort({ submittedAt: -1, createdAt: -1, _id: -1 })
    .lean();

  return latestEvaluation?.roundId || null;
};

const judgeMatchesSubmissionArea = (judge, submission) => {
  const areaKey = normalizeAreaOfFocus(submission?.areaOfFocus || '');
  if (!areaKey) return true;
  if (!Array.isArray(judge?.areasOfFocus) || judge.areasOfFocus.length === 0) return true;
  return judge.areasOfFocus.some((focus) => matchesAreaOfFocus(focus, areaKey));
};

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

router.get('/submission/:submissionId/assignments', authorize('admin', 'superadmin'), async (req, res) => {
  try {
    const { submissionId } = req.params;
    const roundId = await findLatestNationalRoundIdForSubmission(submissionId, req.query?.roundId || null);
    if (!roundId) {
      return res.status(404).json({
        success: false,
        message: 'No National evaluation round found for this submission'
      });
    }

    const assignments = await InterviewAssignment.find({ roundId, submissionId })
      .populate('judgeId', 'name email username')
      .populate('roundId', 'year level status stage')
      .sort({ assignedAt: 1, createdAt: 1 });

    res.json({
      success: true,
      assignment: assignments[0] ? serializeInterviewAssignment(assignments[0]) : null,
      assignments: assignments.map(serializeInterviewAssignment),
      roundContext: {
        roundId,
        roundStage: 'interview',
        isActionable: true
      },
      message: assignments.length
        ? `${assignments.length} interview judge assignment(s) found`
        : 'No interview judges assigned'
    });
  } catch (error) {
    console.error('Get interview assignments error:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Server error'
    });
  }
});

router.get('/submission/:submissionId/eligible-judges', authorize('admin', 'superadmin'), async (req, res) => {
  try {
    const { submissionId } = req.params;
    const submission = await Submission.findById(submissionId).select('_id level areaOfFocus teacherName year');
    if (!submission) {
      return res.status(404).json({
        success: false,
        message: 'Submission not found'
      });
    }
    if (submission.level !== 'National') {
      return res.json({
        success: true,
        judges: [],
        message: 'Interview judge assignment is only available at National level'
      });
    }

    const roundId = await findLatestNationalRoundIdForSubmission(submissionId, req.query?.roundId || null);
    if (!roundId) {
      return res.json({
        success: true,
        judges: [],
        message: 'No National evaluation round found for this submission'
      });
    }

    const eligibleSubmissionIds = await getNationalInterviewEligibleSubmissionIds({ roundId });
    if (!eligibleSubmissionIds.has(String(submissionId))) {
      return res.json({
        success: true,
        judges: [],
        message: 'Only top 5 National submissions in each area can be assigned interview judges'
      });
    }

    const existingAssignments = await InterviewAssignment.find({ roundId, submissionId }).select('judgeId');
    const assignedJudgeIds = new Set(existingAssignments.map((assignment) => String(assignment.judgeId)));
    if (assignedJudgeIds.size >= NATIONAL_INTERVIEW_PANEL_SIZE) {
      return res.json({
        success: true,
        judges: [],
        message: `This submission already has ${NATIONAL_INTERVIEW_PANEL_SIZE} interview judges`
      });
    }

    const nationalJudges = await User.find({
      role: 'judge',
      status: 'active',
      assignedLevel: 'National'
    })
      .select('_id name email username assignedLevel areasOfFocus')
      .sort({ name: 1 });

    const judges = nationalJudges.filter((judge) =>
      !assignedJudgeIds.has(String(judge._id)) && judgeMatchesSubmissionArea(judge, submission)
    );

    res.json({
      success: true,
      judges,
      message: judges.length
        ? `${judges.length} eligible interview judge(s) found`
        : `No active National judges match area of focus "${submission.areaOfFocus || 'N/A'}"`
    });
  } catch (error) {
    console.error('Get eligible interview judges error:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Server error'
    });
  }
});

router.post(
  '/submission/:submissionId/assignments',
  authorize('admin', 'superadmin'),
  invalidateCacheOnChange(['cache:/api/leaderboard*', 'cache:/api/submissions*', 'cache:/api/interviews*']),
  async (req, res) => {
    try {
      const { submissionId } = req.params;
      const { judgeId } = req.body;

      if (!judgeId) {
        return res.status(400).json({
          success: false,
          message: 'Judge ID is required'
        });
      }

      const submission = await Submission.findById(submissionId).select('_id level areaOfFocus teacherName year');
      if (!submission) {
        return res.status(404).json({
          success: false,
          message: 'Submission not found'
        });
      }
      if (submission.level !== 'National') {
        return res.status(403).json({
          success: false,
          message: 'Interview judge assignment is only available at National level'
        });
      }

      const roundId = await findLatestNationalRoundIdForSubmission(submissionId, req.body?.roundId || req.query?.roundId || null);
      if (!roundId) {
        return res.status(400).json({
          success: false,
          message: 'No National evaluation round found for this submission'
        });
      }

      const eligibleSubmissionIds = await getNationalInterviewEligibleSubmissionIds({ roundId });
      if (!eligibleSubmissionIds.has(String(submissionId))) {
        return res.status(403).json({
          success: false,
          message: 'Only top 5 National submissions in each area can be assigned interview judges'
        });
      }

      const judge = await User.findOne({
        _id: judgeId,
        role: 'judge',
        status: 'active',
        assignedLevel: 'National'
      }).select('_id name email username assignedLevel areasOfFocus');

      if (!judge || !judgeMatchesSubmissionArea(judge, submission)) {
        return res.status(400).json({
          success: false,
          message: `Selected judge is not eligible for area of focus "${submission.areaOfFocus || 'N/A'}"`
        });
      }

      const existing = await InterviewAssignment.findOne({ roundId, submissionId, judgeId });
      if (existing) {
        return res.status(400).json({
          success: false,
          message: 'This judge is already assigned to the interview panel'
        });
      }

      const assignmentCount = await InterviewAssignment.countDocuments({ roundId, submissionId });
      if (assignmentCount >= NATIONAL_INTERVIEW_PANEL_SIZE) {
        return res.status(400).json({
          success: false,
          message: `Interview panel is limited to ${NATIONAL_INTERVIEW_PANEL_SIZE} judges`
        });
      }

      const assignment = await InterviewAssignment.create({
        roundId,
        submissionId,
        judgeId,
        assignedBy: req.user._id
      });
      await assignment.populate('judgeId', 'name email username');
      await assignment.populate('roundId', 'year level status stage');

      await refreshSubmissionAndAreaLeaderboard({ submissionId, roundId });

      res.status(201).json({
        success: true,
        assignment: serializeInterviewAssignment(assignment),
        message: 'Interview judge assigned successfully'
      });
    } catch (error) {
      console.error('Assign interview judge error:', error);
      res.status(500).json({
        success: false,
        message: error.message || 'Server error'
      });
    }
  }
);

router.delete(
  '/assignments/:assignmentId',
  authorize('admin', 'superadmin'),
  invalidateCacheOnChange(['cache:/api/leaderboard*', 'cache:/api/submissions*', 'cache:/api/interviews*']),
  async (req, res) => {
    try {
      const assignment = await InterviewAssignment.findById(req.params.assignmentId);
      if (!assignment) {
        return res.status(404).json({
          success: false,
          message: 'Interview assignment not found'
        });
      }

      const { submissionId, roundId } = assignment;
      await assignment.deleteOne();
      await refreshSubmissionAndAreaLeaderboard({ submissionId, roundId });

      res.json({
        success: true,
        message: 'Interview judge removed successfully'
      });
    } catch (error) {
      console.error('Remove interview judge error:', error);
      res.status(500).json({
        success: false,
        message: error.message || 'Server error'
      });
    }
  }
);

router.get('/eligible', authorize('judge'), async (req, res) => {
  try {
    const assignments = await InterviewAssignment.find({
      judgeId: req.user._id
    })
      .select('submissionId roundId assignedAt createdAt')
      .sort({ assignedAt: -1, createdAt: -1, _id: -1 })
      .lean();

    const assignedBySubmission = new Map();
    const eligibleSubmissionIds = new Set();
    const roundIds = [
      ...new Set(
        assignments
          .map((assignment) => assignment.roundId)
          .filter(Boolean)
          .map((roundId) => String(roundId))
      )
    ];

    for (const assignment of assignments) {
      const submissionId = String(assignment.submissionId || '');
      if (!submissionId || assignedBySubmission.has(submissionId)) continue;
      assignedBySubmission.set(submissionId, assignment);
    }

    for (const roundId of roundIds) {
      const roundEligibleIds = await getNationalInterviewEligibleSubmissionIds({ roundId });
      for (const submissionId of roundEligibleIds) {
        if (assignedBySubmission.has(submissionId)) {
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
    eligibleSubmissions.forEach((submission) => {
      const assignment = assignedBySubmission.get(String(submission._id));
      submission.interviewRoundId = assignment?.roundId || null;
    });
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

    const assignmentQuery = {
      submissionId,
      judgeId: req.user._id,
    };
    const resolvedRoundId = explicitRoundId || req.query?.roundId || null;
    if (resolvedRoundId) {
      assignmentQuery.roundId = resolvedRoundId;
    }

    const interviewAssignment = await InterviewAssignment.findOne(assignmentQuery)
      .populate('roundId', 'year level status stage')
      .sort({ assignedAt: -1, createdAt: -1, _id: -1 });

    if (!interviewAssignment) {
      return res.status(403).json({
        success: false,
        message: 'Only assigned National interview judges can enter interview marks for this submission.'
      });
    }

    const assignmentRoundId = interviewAssignment.roundId?._id || interviewAssignment.roundId;
    if (!assignmentRoundId) {
      return res.status(400).json({
        success: false,
        message: 'The interview assignment is missing its round reference.'
      });
    }

    const eligibleSubmissionIds = await getNationalInterviewEligibleSubmissionIds({
      roundId: assignmentRoundId
    });
    if (!eligibleSubmissionIds.has(String(submissionId))) {
      return res.status(403).json({
        success: false,
        message: 'Only the top 5 submissions in each area of competition after result 1 are eligible for interview marks.'
      });
    }

    const interview = await InterviewEvaluation.findOneAndUpdate(
      {
        roundId: assignmentRoundId,
        submissionId,
        judgeId: req.user._id
      },
      {
        year: Number(submission.year),
        level: 'National',
        roundId: assignmentRoundId,
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

    await refreshSubmissionAndAreaLeaderboard({ submissionId, roundId: assignmentRoundId });

    await logger.logUserActivity(
      'Judge submitted interview marks',
      req.user._id,
      req,
      {
        interviewId: interview._id.toString(),
        roundId: assignmentRoundId.toString(),
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
        id: assignmentRoundId,
        year: interviewAssignment.roundId?.year || submission.year,
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
