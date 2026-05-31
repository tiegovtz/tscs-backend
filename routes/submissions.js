const express = require('express');
const mongoose = require('mongoose');
const Submission = require('../models/Submission');
const SubmissionAssignment = require('../models/SubmissionAssignment');
const CompetitionRound = require('../models/CompetitionRound');
const Evaluation = require('../models/Evaluation');
const { protect, authorize } = require('../middleware/auth');
const { logger } = require('../utils/logger');
const notificationService = require('../services/notificationService');
const { manuallyAssignSubmission, getEligibleJudges, getAssignedJudge } = require('../utils/judgeAssignment');
const User = require('../models/User');
const { cacheMiddleware, invalidateCacheOnChange } = require('../middleware/cache');
const { buildSubmissionQueryForAdmin, canAdminAccessSubmission, canAdminAccessUser } = require('../utils/adminScope');
const {
  resolveSubmissionRoundContext,
  isRoundActionable
} = require('../utils/roundContext');

const router = express.Router();
let RoundSnapshot = null;
try {
  RoundSnapshot = require('../models/RoundSnapshot');
} catch (_error) {
  RoundSnapshot = null;
}

const parseBooleanParam = (value) => {
  if (typeof value === 'boolean') return value;
  if (typeof value !== 'string') return false;
  return ['true', '1', 'yes'].includes(value.toLowerCase());
};

const isMissingMediaValue = (value) => (
  typeof value === 'undefined' ||
  value === null ||
  (typeof value === 'string' && value.trim() === '')
);

const getMissingSubmissionParts = (submission) => {
  const missingParts = [];
  if (isMissingMediaValue(submission.lessonPlanFileUrl)) missingParts.push('lessonPlan');
  if (isMissingMediaValue(submission.videoFileUrl)) missingParts.push('video');
  return missingParts;
};

const buildMissingMediaQuery = () => ({
  $or: [
    { lessonPlanFileUrl: { $exists: false } },
    { lessonPlanFileUrl: null },
    { lessonPlanFileUrl: '' },
    { videoFileUrl: { $exists: false } },
    { videoFileUrl: null },
    { videoFileUrl: '' },
  ]
});

// All routes require authentication
router.use(protect);

// @route   GET /api/submissions
// @desc    Get all submissions (with filters)
// @access  Private
router.get('/', cacheMiddleware(30), async (req, res) => {
  try {
    const {
      level,
      status,
      year,
      category,
      class: classLevel,
      subject,
      region,
      council,
      search,
      page = 1,
      limit = 20
    } = req.query;

    const parsedYear = (typeof year !== 'undefined' && year !== null && Number.isFinite(Number(year)))
      ? Number(year)
      : null;
    const query = { isDeleted: { $ne: true } };
    const andClauses = [];

    let responseMessage = null;
    let judgeAssignmentsCount = 0;
    let judgeAssignmentMap = new Map();

    // Role-based filtering (applied first, cannot be overridden)
    if (req.user.role === 'judge') {
      if (!req.user.assignedLevel) {
        return res.json({
          success: true,
          count: 0,
          submissions: [],
          message: 'Judge assignment not configured. Please contact administrator.'
        });
      }

      query.level = req.user.assignedLevel;

      if (req.user.assignedLevel === 'Council') {
        if (!req.user.assignedRegion || !req.user.assignedCouncil) {
          return res.json({
            success: true,
            count: 0,
            submissions: [],
            message: 'Judge assignment incomplete. Please contact administrator.'
          });
        }
        query.region = req.user.assignedRegion?.trim();
        query.council = req.user.assignedCouncil?.trim();
      } else if (req.user.assignedLevel === 'Regional') {
        if (!req.user.assignedRegion) {
          return res.json({
            success: true,
            count: 0,
            submissions: [],
            message: 'Judge assignment incomplete. Please contact administrator.'
          });
        }
        query.region = req.user.assignedRegion?.trim();
      }
    } else if (req.user.role === 'teacher') {
      query.teacherId = req.user._id;
    } else if (req.user.role === 'admin') {
      Object.assign(query, buildSubmissionQueryForAdmin(req.user));
    }

    // Apply additional filters
    if (status) {
      query.status = status;
    }

    if (parsedYear) query.year = parsedYear;
    if (category) query.category = category;
    if (classLevel) query.class = classLevel;
    if (subject) query.subject = subject;

    if (search) {
      andClauses.push({
        $or: [
          { teacherName: { $regex: search, $options: 'i' } },
          { school: { $regex: search, $options: 'i' } },
          { category: { $regex: search, $options: 'i' } },
          { subject: { $regex: search, $options: 'i' } }
        ]
      });
    }

    // Assignment-based judges only see submissions assigned to them for their level.
    if (req.user.role === 'judge' && ['Council', 'Regional', 'National'].includes(req.user.assignedLevel)) {
      const assignmentsForJudge = await SubmissionAssignment.find({
        level: req.user.assignedLevel,
        judgeId: req.user._id
      })
        .sort({ assignedAt: -1, createdAt: -1, _id: -1 })
        .select('submissionId roundId assignedAt createdAt')
        .lean();

      const assignmentPairs = assignmentsForJudge.map((assignment) => ({
        _id: assignment.submissionId
      }));
      judgeAssignmentMap = new Map(
        assignmentsForJudge.map((assignment) => [
          String(assignment.submissionId),
          {
            roundId: assignment.roundId,
            assignedAt: assignment.assignedAt,
            createdAt: assignment.createdAt
          }
        ])
      );
      judgeAssignmentsCount = assignmentPairs.length;

      if (assignmentPairs.length > 0) {
        andClauses.push({ $or: assignmentPairs });
      } else {
        query._id = { $in: [] };
        responseMessage = 'No submissions are assigned to you.';
      }
    }

    if (andClauses.length > 0) {
      query.$and = andClauses;
    }

    const pageNum = parseInt(page, 10) || 1;
    const limitNum = parseInt(limit, 10) || 20;
    const skip = (pageNum - 1) * limitNum;

    const total = await Submission.countDocuments(query);
    const submissions = await Submission.find(query)
      .populate('teacherId', 'name email username')
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limitNum)
      .lean();

    if (req.user.role === 'judge' && submissions.length > 0) {
      const submissionIds = submissions.map((submission) => submission._id);
      const evaluationDocs = await Evaluation.find({
        submissionId: { $in: submissionIds },
        judgeId: req.user._id
      }).select('submissionId').lean();

      const evaluatedSubmissionIds = new Set(evaluationDocs.map((evaluation) => String(evaluation.submissionId)));

      for (const submission of submissions) {
        const submissionId = String(submission._id);
        const assignedMeta = judgeAssignmentMap.get(submissionId) || null;
        const judgeCompleted = evaluatedSubmissionIds.has(submissionId);
        submission.judgeCompleted = judgeCompleted;
        submission.judgeCompletionStatus = judgeCompleted ? 'completed' : 'pending';
        submission.assignedRoundId = assignedMeta?.roundId || submission.roundId || null;
      }
    }

    const response = {
      success: true,
      count: submissions.length,
      total,
      page: pageNum,
      pages: Math.ceil(total / limitNum),
      limit: limitNum,
      submissions
    };

    if (responseMessage) {
      response.message = responseMessage;
    }

    if (process.env.NODE_ENV === 'development' && req.user.role === 'judge') {
      response.debug = {
        judgeAssignment: {
          assignedLevel: req.user.assignedLevel,
          assignedRegion: req.user.assignedRegion,
          assignedCouncil: req.user.assignedCouncil,
          assignmentsCount: judgeAssignmentsCount
        },
        query
      };
    }

    logger.logUserActivity(
      'User viewed submissions list',
      req.user._id,
      req,
      {
        role: req.user.role,
        filters: { level, status, year, category, subject, region, council },
        count: submissions.length
      },
      'read'
    ).catch((err) => {
      console.error('Error logging user activity:', err);
    });

    res.json(response);
  } catch (error) {
    console.error('Get submissions error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
});

// @route   DELETE /api/submissions/assignments/:assignmentId
// @desc    Delete a submission assignment by ID
// @access  Private (Admin/Superadmin only)
router.delete(
  '/assignments/:assignmentId',
  authorize('admin', 'superadmin'),
  invalidateCacheOnChange(['cache:/api/submissions*', 'cache:/api/users*', 'cache:/api/competition-rounds*']),
  async (req, res) => {
    try {
      if (!mongoose.Types.ObjectId.isValid(req.params.assignmentId)) {
        return res.status(400).json({
          success: false,
          message: 'Invalid submission assignment ID'
        });
      }

      const assignment = await SubmissionAssignment.findById(req.params.assignmentId)
        .populate('submissionId')
        .populate('judgeId', 'name email username assignedLevel assignedRegion assignedCouncil')
        .populate('roundId', 'year level status region council endTime');

      if (!assignment) {
        return res.status(404).json({
          success: false,
          message: 'Submission assignment not found'
        });
      }

      if (!assignment.submissionId) {
        return res.status(404).json({
          success: false,
          message: 'Submission linked to this assignment was not found'
        });
      }

      if (req.user.role === 'admin' && !canAdminAccessSubmission(req.user, assignment.submissionId)) {
        return res.status(403).json({
          success: false,
          message: 'Not authorized to delete this submission assignment'
        });
      }

      // Keep "unassigned" strictly equivalent to "currently without judges":
      // if evaluation already exists for this submission in the assignment's round,
      // the assignment must remain intact.
      const evaluationExists = await Evaluation.exists({
        submissionId: assignment.submissionId._id,
        roundId: assignment.roundId?._id || assignment.roundId
      });
      if (evaluationExists) {
        return res.status(409).json({
          success: false,
          message: 'Cannot remove assignment because this submission has already been evaluated in this round'
        });
      }

      await logger.logAdminAction(
        'Admin deleted submission assignment',
        req.user._id,
        req,
        {
          assignmentId: assignment._id.toString(),
          submissionId: assignment.submissionId._id.toString(),
          judgeId: assignment.judgeId?._id?.toString() || assignment.judgeId?.toString(),
          roundId: assignment.roundId?._id?.toString() || assignment.roundId?.toString(),
          level: assignment.level,
          region: assignment.region,
          council: assignment.council
        },
        'warning',
        'delete'
      );

      await assignment.deleteOne();

      res.json({
        success: true,
        message: 'Submission assignment deleted successfully'
      });
    } catch (error) {
      console.error('Delete submission assignment error:', error);
      res.status(500).json({
        success: false,
        message: 'Server error'
      });
    }
  }
);

// @route   GET /api/submissions/unassigned
// @desc    Get submissions that currently have no judge assignment
// @access  Private (Admin/Superadmin/Stakeholder)
router.get('/unassigned', authorize('admin', 'superadmin', 'stakeholder'), cacheMiddleware(30), async (req, res) => {
  try {
    const {
      roundId,
      level,
      status,
      year,
      category,
      class: classLevel,
      subject,
      region,
      council,
      search,
      page = 1,
      limit = 20
    } = req.query;

    const parsedYear = (typeof year !== 'undefined' && year !== null && Number.isFinite(Number(year)))
      ? Number(year)
      : null;
    const pageNum = parseInt(page, 10) || 1;
    const limitNum = parseInt(limit, 10) || 20;
    const skip = (pageNum - 1) * limitNum;

    const normalize = (value) => (value ? value.toString().trim() : '');
    const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const toExactRegex = (value) => {
      const normalized = normalize(value);
      return normalized ? new RegExp(`^${escapeRegExp(normalized)}$`, 'i') : null;
    };

    let effectiveRoundId = roundId;
    if (!effectiveRoundId) {
      const latestActiveRound = await CompetitionRound.findOne({ status: 'active' })
        .sort({ updatedAt: -1, createdAt: -1 })
        .select('_id');
      effectiveRoundId = latestActiveRound?._id?.toString() || null;
    }

    if (effectiveRoundId) {
      if (!mongoose.Types.ObjectId.isValid(effectiveRoundId)) {
        return res.status(400).json({
          success: false,
          message: 'Invalid roundId'
        });
      }

      const round = await CompetitionRound.findById(effectiveRoundId);
      if (!round) {
        return res.status(404).json({
          success: false,
          message: 'Competition round not found'
        });
      }

      if (req.user.role === 'stakeholder') {
        const latestActiveRound = await CompetitionRound.findOne({ status: 'active' })
          .sort({ updatedAt: -1, createdAt: -1 })
          .select('_id status');

        if (!latestActiveRound || String(latestActiveRound._id) !== String(round._id)) {
          return res.status(403).json({
            success: false,
            message: 'Stakeholders can only view unassigned submissions for the current active round'
          });
        }
      }

      if (!['Council', 'Regional', 'National'].includes(round.level)) {
        return res.status(400).json({
          success: false,
          message: 'Unassigned submissions are only available for Council, Regional, and National rounds'
        });
      }

      if (level && level !== round.level) {
        return res.status(400).json({
          success: false,
          message: `Provided level does not match round level (${round.level})`
        });
      }

      const scopedRegion = normalize(region) || normalize(round.region);
      const scopedCouncil = normalize(council) || normalize(round.council);
      const scopeRegionRegex = toExactRegex(scopedRegion);
      const scopeCouncilRegex = toExactRegex(scopedCouncil);

      let snapshotSubmissionIds = Array.isArray(round.pendingSubmissionsSnapshot)
        ? round.pendingSubmissionsSnapshot
        : [];
      let snapshotDoc = null;
      if (snapshotSubmissionIds.length === 0 && RoundSnapshot) {
        snapshotDoc = await RoundSnapshot.findOne({ roundId: round._id }).select('submissionIds');
        snapshotSubmissionIds = snapshotDoc?.submissionIds || [];
      }
      const hasSnapshotContext = Boolean(
        round.activationSnapshotId ||
        snapshotDoc ||
        snapshotSubmissionIds.length > 0
      );

      const excludedStatuses = ['evaluated', 'promoted', 'eliminated', 'disqualified'];
      const excludedStatusSet = new Set(excludedStatuses);
      const requestedStatusNormalized = normalize(status).toLowerCase();

      const submissionQuery = hasSnapshotContext
        ? {
            _id: { $in: snapshotSubmissionIds },
            year: round.year,
            level: round.level,
            isDeleted: { $ne: true }
          }
        : {
            year: round.year,
            level: round.level,
            isDeleted: { $ne: true }
          };

      if (req.user.role === 'admin') {
        Object.assign(submissionQuery, buildSubmissionQueryForAdmin(req.user));
      }
      if (status) {
        submissionQuery.status = status;
      } else {
        submissionQuery.status = { $nin: excludedStatuses };
      }
      submissionQuery.disqualified = { $ne: true };
      if (category) submissionQuery.category = category;
      if (classLevel) submissionQuery.class = classLevel;
      if (subject) submissionQuery.subject = subject;
      if (scopeRegionRegex) submissionQuery.region = scopeRegionRegex;
      if (scopeCouncilRegex) submissionQuery.council = scopeCouncilRegex;
      if (search) {
        submissionQuery.$or = [
          { teacherName: { $regex: search, $options: 'i' } },
          { school: { $regex: search, $options: 'i' } },
          { category: { $regex: search, $options: 'i' } },
          { subject: { $regex: search, $options: 'i' } }
        ];
      }

      const allScopedSubmissions = await Submission.find(submissionQuery)
        .sort({ createdAt: -1 });
      const submissionIds = allScopedSubmissions.map((sub) => sub._id);

      const historicalAssignedSubmissionIds = submissionIds.length
        ? await SubmissionAssignment.distinct('submissionId', {
            roundId: round._id,
            level: round.level,
            submissionId: { $in: submissionIds }
          })
        : [];
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
      const evaluatedSubmissionIds = submissionIds.length
        ? await Evaluation.distinct('submissionId', {
            submissionId: { $in: submissionIds },
            $or: evaluationScope
          })
        : [];
      const historicalAssignedSubmissionIdSet = new Set(
        historicalAssignedSubmissionIds.map((id) => id.toString())
      );
      const evaluatedSubmissionIdSet = new Set(
        evaluatedSubmissionIds.map((id) => id.toString())
      );

      const unassignedSubmissions = allScopedSubmissions.filter(
        (submission) => {
          const submissionId = submission._id.toString();
          const submissionStatus = String(submission.status || '').toLowerCase();
          if (excludedStatusSet.has(requestedStatusNormalized)) return false;
          if (excludedStatusSet.has(submissionStatus)) return false;
          if (submission.disqualified === true) return false;
          if (historicalAssignedSubmissionIdSet.has(submissionId)) return false;
          if (evaluatedSubmissionIdSet.has(submissionId)) return false;
          return true;
        }
      );
      const total = unassignedSubmissions.length;
      const submissions = unassignedSubmissions.slice(skip, skip + limitNum);

      return res.json({
        success: true,
        count: submissions.length,
        total,
        page: pageNum,
        pages: Math.ceil(total / limitNum),
        limit: limitNum,
        filters: {
          roundId: effectiveRoundId,
          level: round.level,
          status,
          year: round.year,
          category,
          subject,
          region: scopedRegion || null,
          council: scopedCouncil || null,
          search
        },
        submissions
      });
    }
    return res.json({
      success: true,
      count: 0,
      total: 0,
      page: pageNum,
      pages: 0,
      limit: limitNum,
      filters: { roundId: null, level, status, year, category, subject, region, council, search },
      message: 'No active round found',
      submissions: []
    });
  } catch (error) {
    console.error('Get unassigned submissions error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
});

// @route   GET /api/submissions/deleted
// @desc    Get soft-deleted submissions
// @access  Private (Admin/Superadmin)
router.get('/deleted', authorize('admin', 'superadmin'), async (req, res) => {
  try {
    const {
      level,
      status,
      year,
      category,
      class: classLevel,
      subject,
      search,
      page = 1,
      limit = 20
    } = req.query;

    const parsedYear = (typeof year !== 'undefined' && year !== null && Number.isFinite(Number(year)))
      ? Number(year)
      : null;
    const query = { isDeleted: true };
    const andClauses = [];

    if (req.user.role === 'admin') {
      Object.assign(query, buildSubmissionQueryForAdmin(req.user));
    }

    if (level) query.level = level;
    if (status) query.status = status;
    if (parsedYear) query.year = parsedYear;
    if (category) query.category = category;
    if (classLevel) query.class = classLevel;
    if (subject) query.subject = subject;

    if (search) {
      andClauses.push({
        $or: [
          { teacherName: { $regex: search, $options: 'i' } },
          { school: { $regex: search, $options: 'i' } },
          { category: { $regex: search, $options: 'i' } },
          { subject: { $regex: search, $options: 'i' } }
        ]
      });
    }

    if (andClauses.length > 0) {
      query.$and = andClauses;
    }

    const pageNum = parseInt(page, 10) || 1;
    const limitNum = parseInt(limit, 10) || 20;
    const skip = (pageNum - 1) * limitNum;

    const total = await Submission.countDocuments(query);
    const submissions = await Submission.find(query)
      .populate('teacherId', 'name email username')
      .sort({ deletedAt: -1, createdAt: -1 })
      .skip(skip)
      .limit(limitNum);

    res.json({
      success: true,
      count: submissions.length,
      total,
      page: pageNum,
      pages: Math.ceil(total / limitNum),
      limit: limitNum,
      submissions
    });
  } catch (error) {
    console.error('Get deleted submissions error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
});

// @route   GET /api/submissions/faulty
// @desc    Get submissions missing lesson plan and/or video media
// @access  Private (Admin/Superadmin)
router.get('/faulty', authorize('admin', 'superadmin'), async (req, res) => {
  try {
    const {
      level,
      year,
      category,
      class: classLevel,
      subject,
      search,
      page = 1,
      limit = 20
    } = req.query;

    const parsedYear = (typeof year !== 'undefined' && year !== null && Number.isFinite(Number(year)))
      ? Number(year)
      : null;

    const query = {
      isDeleted: { $ne: true },
      ...buildMissingMediaQuery()
    };

    if (req.user.role === 'admin') {
      Object.assign(query, buildSubmissionQueryForAdmin(req.user));
    }

    if (level) query.level = level;
    if (parsedYear) query.year = parsedYear;
    if (category) query.category = category;
    if (classLevel) query.class = classLevel;
    if (subject) query.subject = subject;

    if (search) {
      query.$and = query.$and || [];
      query.$and.push({
        $or: [
          { teacherName: { $regex: search, $options: 'i' } },
          { school: { $regex: search, $options: 'i' } },
          { areaOfFocus: { $regex: search, $options: 'i' } },
          { category: { $regex: search, $options: 'i' } },
          { subject: { $regex: search, $options: 'i' } }
        ]
      });
    }

    const pageNum = parseInt(page, 10) || 1;
    const limitNum = parseInt(limit, 10) || 20;
    const skip = (pageNum - 1) * limitNum;

    const total = await Submission.countDocuments(query);
    const submissions = await Submission.find(query)
      .populate('teacherId', 'name email username')
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limitNum)
      .lean();

    const faultySubmissions = submissions.map((submission) => ({
      ...submission,
      missingParts: getMissingSubmissionParts(submission)
    }));

    res.json({
      success: true,
      count: faultySubmissions.length,
      total,
      page: pageNum,
      pages: Math.ceil(total / limitNum),
      limit: limitNum,
      submissions: faultySubmissions
    });
  } catch (error) {
    console.error('Get faulty submissions error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
});

// @route   PATCH /api/submissions/:id/faulty-fix
// @desc    Admin/Superadmin directly uploads missing media part
// @access  Private (Admin/Superadmin)
router.patch('/:id/faulty-fix', authorize('admin', 'superadmin'), invalidateCacheOnChange('cache:/api/submissions*'), async (req, res) => {
  try {
    const { part, lessonPlanFileName, lessonPlanFileUrl, videoFileName, videoFileUrl, videoOriginalBytes } = req.body;
    if (!part || !['lessonPlan', 'video'].includes(part)) {
      return res.status(400).json({ success: false, message: 'Part must be lessonPlan or video' });
    }

    const submission = await Submission.findOne({ _id: req.params.id, isDeleted: { $ne: true } });
    if (!submission) {
      return res.status(404).json({ success: false, message: 'Submission not found' });
    }
    if (req.user.role === 'admin' && !canAdminAccessSubmission(req.user, submission)) {
      return res.status(403).json({ success: false, message: 'Not authorized to update this submission' });
    }

    const missingParts = getMissingSubmissionParts(submission);
    if (!missingParts.includes(part)) {
      return res.status(400).json({
        success: false,
        message: `Submission is not missing ${part === 'lessonPlan' ? 'lesson plan' : 'video'}`
      });
    }

    if (part === 'lessonPlan') {
      if (!lessonPlanFileUrl || typeof lessonPlanFileUrl !== 'string') {
        return res.status(400).json({ success: false, message: 'lessonPlanFileUrl is required for lessonPlan fix' });
      }
      submission.lessonPlanFileUrl = lessonPlanFileUrl;
      if (lessonPlanFileName) submission.lessonPlanFileName = lessonPlanFileName;
    } else {
      if (!videoFileUrl || typeof videoFileUrl !== 'string') {
        return res.status(400).json({ success: false, message: 'videoFileUrl is required for video fix' });
      }
      submission.videoFileUrl = videoFileUrl;
      if (videoFileName) submission.videoFileName = videoFileName;
      if (typeof videoOriginalBytes !== 'undefined') {
        submission.videoOriginalBytes = Number(videoOriginalBytes);
      }
    }

    if (submission.reuploadRequest?.requested && submission.reuploadRequest?.part === part) {
      submission.reuploadRequest.requested = false;
      submission.reuploadRequest.status = 'completed';
      submission.reuploadRequest.resolvedAt = new Date();
    }

    await submission.save();

    await logger.logAdminAction(
      'Admin fixed faulty submission media',
      req.user._id,
      req,
      {
        submissionId: submission._id.toString(),
        part,
        teacherId: submission.teacherId?.toString()
      },
      'success',
      'update'
    );

    res.json({
      success: true,
      message: `${part === 'lessonPlan' ? 'Lesson plan' : 'Video'} fixed successfully`,
      submission
    });
  } catch (error) {
    console.error('Faulty fix error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// @route   POST /api/submissions/:id/request-reupload
// @desc    Request teacher to reupload missing media part
// @access  Private (Admin/Superadmin)
router.post('/:id/request-reupload', authorize('admin', 'superadmin'), invalidateCacheOnChange('cache:/api/submissions*'), async (req, res) => {
  try {
    const { part, note } = req.body;
    if (!part || !['lessonPlan', 'video'].includes(part)) {
      return res.status(400).json({ success: false, message: 'Part must be lessonPlan or video' });
    }

    const submission = await Submission.findOne({ _id: req.params.id, isDeleted: { $ne: true } });
    if (!submission) {
      return res.status(404).json({ success: false, message: 'Submission not found' });
    }
    if (req.user.role === 'admin' && !canAdminAccessSubmission(req.user, submission)) {
      return res.status(403).json({ success: false, message: 'Not authorized to request reupload for this submission' });
    }

    const missingParts = getMissingSubmissionParts(submission);
    if (!missingParts.includes(part)) {
      return res.status(400).json({
        success: false,
        message: `Submission is not missing ${part === 'lessonPlan' ? 'lesson plan' : 'video'}`
      });
    }

    submission.reuploadRequest = {
      requested: true,
      requestedBy: req.user._id,
      requestedAt: new Date(),
      part,
      note: typeof note === 'string' ? note.trim() : '',
      status: 'pending',
      resolvedAt: null
    };
    await submission.save();

    await logger.logAdminAction(
      'Admin requested teacher reupload',
      req.user._id,
      req,
      {
        submissionId: submission._id.toString(),
        teacherId: submission.teacherId?.toString(),
        part
      },
      'warning',
      'update'
    );

    await notificationService.emit('SYSTEM_NOTIFICATION', {
      userId: submission.teacherId,
      title: 'Submission reupload required',
      message: `Please reupload your missing ${part === 'lessonPlan' ? 'lesson plan PDF' : 'video file'} for submission "${submission.areaOfFocus || submission.subject}".`,
      metadata: {
        event: 'submission_reupload_requested',
        submissionId: submission._id.toString(),
        part,
        note: submission.reuploadRequest.note || undefined
      },
      sendEmail: true
    });

    res.json({
      success: true,
      message: 'Teacher reupload request sent successfully',
      submission
    });
  } catch (error) {
    console.error('Request reupload error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// @route   PATCH /api/submissions/:id/teacher-reupload
// @desc    Teacher uploads only requested media part
// @access  Private (Teacher)
router.patch('/:id/teacher-reupload', authorize('teacher'), invalidateCacheOnChange('cache:/api/submissions*'), async (req, res) => {
  try {
    const { part, lessonPlanFileName, lessonPlanFileUrl, videoFileName, videoFileUrl, videoOriginalBytes } = req.body;
    if (!part || !['lessonPlan', 'video'].includes(part)) {
      return res.status(400).json({ success: false, message: 'Part must be lessonPlan or video' });
    }

    const submission = await Submission.findOne({
      _id: req.params.id,
      isDeleted: { $ne: true },
      teacherId: req.user._id
    });
    if (!submission) {
      return res.status(404).json({ success: false, message: 'Submission not found' });
    }

    if (!submission.reuploadRequest?.requested || submission.reuploadRequest?.status !== 'pending') {
      return res.status(400).json({ success: false, message: 'No pending reupload request for this submission' });
    }
    if (submission.reuploadRequest.part !== part) {
      return res.status(400).json({
        success: false,
        message: `Only ${submission.reuploadRequest.part === 'lessonPlan' ? 'lesson plan' : 'video'} reupload is currently allowed`
      });
    }

    if (part === 'lessonPlan') {
      if (!lessonPlanFileUrl || typeof lessonPlanFileUrl !== 'string') {
        return res.status(400).json({ success: false, message: 'lessonPlanFileUrl is required for lessonPlan reupload' });
      }
      submission.lessonPlanFileUrl = lessonPlanFileUrl;
      if (lessonPlanFileName) submission.lessonPlanFileName = lessonPlanFileName;
    } else {
      if (!videoFileUrl || typeof videoFileUrl !== 'string') {
        return res.status(400).json({ success: false, message: 'videoFileUrl is required for video reupload' });
      }
      submission.videoFileUrl = videoFileUrl;
      if (videoFileName) submission.videoFileName = videoFileName;
      if (typeof videoOriginalBytes !== 'undefined') {
        submission.videoOriginalBytes = Number(videoOriginalBytes);
      }
    }

    submission.reuploadRequest.requested = false;
    submission.reuploadRequest.status = 'completed';
    submission.reuploadRequest.resolvedAt = new Date();

    await submission.save();

    await logger.logUserActivity(
      'Teacher completed requested media reupload',
      req.user._id,
      req,
      {
        submissionId: submission._id.toString(),
        part
      },
      'update'
    );

    res.json({
      success: true,
      message: `${part === 'lessonPlan' ? 'Lesson plan' : 'Video'} reuploaded successfully`,
      submission
    });
  } catch (error) {
    console.error('Teacher reupload error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// @route   GET /api/submissions/:id
// @desc    Get single submission
// @access  Private
router.get('/:id', async (req, res) => {
  try {
    const submission = await Submission.findOne({ _id: req.params.id, isDeleted: { $ne: true } })
      .populate('teacherId', 'name email username school');

    if (!submission) {
      return res.status(404).json({
        success: false,
        message: 'Submission not found'
      });
    }

    // Check authorization
    if (req.user.role === 'teacher' && submission.teacherId._id.toString() !== req.user._id.toString()) {
      // Log unauthorized access attempt
      await logger.logSecurity(
        'Unauthorized submission access attempt',
        req.user._id,
        req,
        { submissionId: req.params.id },
        'warning'
      );
      
      return res.status(403).json({
        success: false,
        message: 'Not authorized to access this submission'
      });
    }

    // Judge scope: only assigned submissions at their exact level and round context
    if (req.user.role === 'judge') {
      if (!req.user.assignedLevel || req.user.assignedLevel !== submission.level) {
        return res.status(403).json({
          success: false,
          message: 'Not authorized to access this submission'
        });
      }

      if (submission.level === 'Council' || submission.level === 'Regional') {
        const latestAssignment = await SubmissionAssignment.findOne({
          submissionId: submission._id
        })
          .sort({ assignedAt: -1, createdAt: -1, _id: -1 })
          .select('judgeId');

        if (!latestAssignment || String(latestAssignment.judgeId) !== String(req.user._id)) {
          return res.status(403).json({
            success: false,
            message: 'Not authorized to access this submission'
          });
        }
      } else if (submission.level === 'National' && req.user.assignedLevel !== 'National') {
        return res.status(403).json({
          success: false,
          message: 'Not authorized to access this submission'
        });
      }
    }

    // Admin scope: only allow viewing submissions in their scope
    if (req.user.role === 'admin' && !canAdminAccessSubmission(req.user, submission)) {
      return res.status(403).json({
        success: false,
        message: 'Not authorized to access this submission'
      });
    }

    // Log submission view
    await logger.logUserActivity(
      'User viewed submission details',
      req.user._id,
      req,
      { 
        submissionId: submission._id.toString(),
        submissionLevel: submission.level,
        teacherId: submission.teacherId._id.toString()
      },
      'read'
    );

    res.json({
      success: true,
      submission
    });
  } catch (error) {
    console.error('Get submission error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
});

// @route   POST /api/submissions
// @desc    Create new submission
// @access  Private (Teacher, Admin, Superadmin)
router.post('/', authorize('teacher', 'admin', 'superadmin'), invalidateCacheOnChange('cache:/api/submissions*'), async (req, res) => {
  try {
    const submissionData = {
      ...req.body,
      teacherId: req.user.role === 'teacher' ? req.user._id : req.body.teacherId || req.user._id
    };

    // Log the attempt for debugging
    console.log('Processing submission for teacher:', submissionData.teacherId);

    const { videoFileName, videoFileUrl, videoOriginalBytes } = req.body;
    const hasVideoInfo = typeof videoFileName === 'string' && videoFileName.trim() &&
      typeof videoFileUrl === 'string' && videoFileUrl.trim();

    if (hasVideoInfo) {
      submissionData.videoFileName = videoFileName.trim();
      submissionData.videoFileUrl = videoFileUrl.trim();
      const parsedBytes = Number(videoOriginalBytes);
      if (!Number.isNaN(parsedBytes)) {
        submissionData.videoOriginalBytes = parsedBytes;
      }
    }

    // Validate required fields
    if (!submissionData.areaOfFocus) {
      return res.status(400).json({
        success: false,
        message: 'Area of focus is required'
      });
    }

    if (!submissionData.year) {
      return res.status(400).json({
        success: false,
        message: 'Year is required'
      });
    }

    // Check if teacher already has a submission in the same area of focus for the same year
    const existingSubmission = await Submission.findOne({
      teacherId: submissionData.teacherId,
      areaOfFocus: submissionData.areaOfFocus,
      year: submissionData.year,
      isDeleted: { $ne: true }
    });

    if (existingSubmission) {
      return res.status(400).json({
        success: false,
        message: `You have already submitted an entry for "${submissionData.areaOfFocus}" in ${submissionData.year}. Each teacher can only submit one entry per area of focus per year.`,
        existingSubmission: {
          id: existingSubmission._id,
          areaOfFocus: existingSubmission.areaOfFocus,
          year: existingSubmission.year,
          status: existingSubmission.status,
          level: existingSubmission.level
        }
      });
    }

    console.log('Creating submission with data:', {
      ...submissionData,
      videoFileUrl: submissionData.videoFileUrl ? 'PRESENT' : 'MISSING',
      lessonPlanFileUrl: submissionData.lessonPlanFileUrl ? 'PRESENT' : 'MISSING'
    });

    const submission = await Submission.create(submissionData);
    console.log('Submission created successfully:', submission._id);

    // Log submission creation
    const logAction = req.user.role === 'teacher' 
      ? 'User submitted new entry' 
      : `${req.user.role} created submission`;
    
    await logger.logUserActivity(
      logAction,
      req.user._id,
      req,
      {
        submissionId: submission._id.toString(),
        level: submission.level,
        category: submission.category,
        subject: submission.subject,
        areaOfFocus: submission.areaOfFocus
      },
      'create'
    );

    // Round snapshots are frozen at activation.
    // New submissions are not auto-assigned into currently running rounds.

    // Create notification for teacher when submission is successful
    if (req.user.role === 'teacher' || submissionData.teacherId) {
      const teacherId = req.user.role === 'teacher' ? req.user._id : submissionData.teacherId;
      const roundName = `${submission.level} Round`;
      
      // Create notification (non-blocking - don't fail submission if notification fails)
      notificationService.handleSubmissionSuccessful({
        userId: teacherId,
        submissionId: submission._id.toString(),
        roundName: roundName,
        subject: submission.subject
      }).catch(error => {
        // Log error but don't fail the submission
        console.error('Error creating submission notification:', error);
      });
    }

    res.status(201).json({
      success: true,
      submission
    });
  } catch (error) {
    console.error('Create submission error:', error);
    
    // Return detailed error message to client
    res.status(500).json({
      success: false,
      message: error.message || 'Server error',
      // Include stack trace if needed for debugging, or validation errors if any
      details: error.errors ? Object.keys(error.errors).map(key => ({ field: key, message: error.errors[key].message })) : null
    });
  }
});

// @route   PUT /api/submissions/:id
// @desc    Update submission
// @access  Private (Teacher owns it, or Admin/Superadmin)
router.put('/:id', authorize('teacher', 'admin', 'superadmin'), invalidateCacheOnChange('cache:/api/submissions*'), async (req, res) => {
  try {
    const submission = await Submission.findOne({ _id: req.params.id, isDeleted: { $ne: true } });

    if (!submission) {
      return res.status(404).json({
        success: false,
        message: 'Submission not found'
      });
    }

    // Check authorization
    if (req.user.role === 'teacher' && submission.teacherId.toString() !== req.user._id.toString()) {
      return res.status(403).json({
        success: false,
        message: 'Not authorized to update this submission'
      });
    }

    // Admin scope: only allow updating submissions in their scope
    if (req.user.role === 'admin' && !canAdminAccessSubmission(req.user, submission)) {
      return res.status(403).json({
        success: false,
        message: 'Not authorized to update this submission'
      });
    }

    // Promotion/demotion (level change) is superadmin-only.
    if (
      req.user.role === 'admin'
      && Object.prototype.hasOwnProperty.call(req.body || {}, 'level')
      && String(req.body.level) !== String(submission.level)
    ) {
      return res.status(403).json({
        success: false,
        message: 'Only superadmin can promote or demote submissions'
      });
    }

    const updatedSubmission = await Submission.findOneAndUpdate(
      { _id: req.params.id, isDeleted: { $ne: true } },
      req.body,
      { new: true, runValidators: true }
    ).populate('teacherId', 'name email username');

    const assignmentMetadataChanged = updatedSubmission &&
      (
        updatedSubmission.level !== submission.level ||
        String(updatedSubmission.region || '') !== String(submission.region || '') ||
        String(updatedSubmission.council || '') !== String(submission.council || '')
      );

    // Keep assignment metadata aligned with current submission location/level for actionable round scopes.
    if (
      assignmentMetadataChanged &&
      ['Council', 'Regional'].includes(updatedSubmission.level) &&
      updatedSubmission.region
    ) {
      const actionableRoundIds = new Set();
      if (submission.roundId) actionableRoundIds.add(String(submission.roundId));
      if (updatedSubmission.roundId) actionableRoundIds.add(String(updatedSubmission.roundId));

      if (actionableRoundIds.size === 0 && updatedSubmission.year) {
        const actionableRounds = await CompetitionRound.find({
          year: updatedSubmission.year,
          level: updatedSubmission.level,
          status: { $in: ['active', 'ended'] }
        }).select('_id');
        for (const round of actionableRounds) {
          actionableRoundIds.add(String(round._id));
        }
      }

      if (actionableRoundIds.size > 0) {
        await SubmissionAssignment.updateMany(
          {
            submissionId: updatedSubmission._id,
            roundId: { $in: [...actionableRoundIds] }
          },
          {
            $set: {
              level: updatedSubmission.level,
              region: updatedSubmission.region,
              council: updatedSubmission.council || null
            }
          }
        );
      }
    }

    // Determine log action based on what was updated
    const levelChanged = req.body.level && req.body.level !== submission.level;
    const statusChanged = req.body.status && req.body.status !== submission.status;
    
    let logAction = 'User updated submission';
    let logSeverity = 'info';
    
    if (levelChanged && req.user.role !== 'teacher') {
      logAction = `Admin ${req.body.level > submission.level ? 'promoted' : 'demoted'} submission to ${req.body.level} level`;
      logSeverity = 'success';
    } else if (statusChanged) {
      if (req.body.status === 'approved') {
        logAction = 'Admin approved submission';
        logSeverity = 'success';
      } else if (req.body.status === 'eliminated') {
        logAction = 'Admin eliminated submission';
        logSeverity = 'warning';
      }
    }

    // Log submission update
    if (req.user.role === 'admin' || req.user.role === 'superadmin') {
      await logger.logAdminAction(
        logAction,
        req.user._id,
        req,
        {
          submissionId: req.params.id,
          previousLevel: submission.level,
          newLevel: req.body.level || submission.level,
          previousStatus: submission.status,
          newStatus: req.body.status || submission.status,
          updatedFields: Object.keys(req.body)
        },
        logSeverity,
        'update'
      );
    } else {
      await logger.logUserActivity(
        logAction,
        req.user._id,
        req,
        {
          submissionId: req.params.id,
          updatedFields: Object.keys(req.body)
        },
        'update'
      );
    }

    res.json({
      success: true,
      submission: updatedSubmission
    });
  } catch (error) {
    console.error('Update submission error:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Server error'
    });
  }
});

// @route   DELETE /api/submissions/:id
// @desc    Soft delete submission
// @access  Private (Admin/Superadmin only)
router.delete('/:id', authorize('admin', 'superadmin'), invalidateCacheOnChange('cache:/api/submissions*'), async (req, res) => {
  try {
    const submission = await Submission.findOne({ _id: req.params.id, isDeleted: { $ne: true } });

    if (!submission) {
      return res.status(404).json({
        success: false,
        message: 'Submission not found'
      });
    }

    // Admin scope: only allow deleting submissions in their scope
    if (req.user.role === 'admin' && !canAdminAccessSubmission(req.user, submission)) {
      return res.status(403).json({
        success: false,
        message: 'Not authorized to delete this submission'
      });
    }

    // Log submission deletion before soft deleting
    await logger.logAdminAction(
      'Admin deleted submission',
      req.user._id,
      req,
      {
        submissionId: req.params.id,
        teacherId: submission.teacherId?.toString(),
        teacherName: submission.teacherName,
        level: submission.level,
        category: submission.category,
        subject: submission.subject
      },
      'error',
      'delete'
    );

    submission.isDeleted = true;
    submission.deletedAt = new Date();
    submission.deletedBy = req.user._id;
    await submission.save();

    res.json({
      success: true,
      message: 'Submission deleted successfully'
    });
  } catch (error) {
    console.error('Delete submission error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
});

// @route   POST /api/submissions/:id/restore
// @desc    Restore soft-deleted submission
// @access  Private (Admin/Superadmin only)
router.post('/:id/restore', authorize('admin', 'superadmin'), invalidateCacheOnChange('cache:/api/submissions*'), async (req, res) => {
  try {
    const submission = await Submission.findOne({ _id: req.params.id, isDeleted: true });
    if (!submission) {
      return res.status(404).json({
        success: false,
        message: 'Deleted submission not found'
      });
    }

    if (req.user.role === 'admin' && !canAdminAccessSubmission(req.user, submission)) {
      return res.status(403).json({
        success: false,
        message: 'Not authorized to restore this submission'
      });
    }

    submission.isDeleted = false;
    submission.deletedAt = null;
    submission.deletedBy = null;
    await submission.save();

    await logger.logAdminAction(
      'Admin restored submission',
      req.user._id,
      req,
      {
        submissionId: submission._id.toString(),
        teacherId: submission.teacherId?.toString(),
        teacherName: submission.teacherName,
        level: submission.level
      },
      'success',
      'update'
    );

    res.json({
      success: true,
      message: 'Submission restored successfully',
      submission
    });
  } catch (error) {
    console.error('Restore submission error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
});

// @route   DELETE /api/submissions/:id/permanent
// @desc    Permanently delete a soft-deleted submission
// @access  Private (Admin/Superadmin only)
router.delete('/:id/permanent', authorize('admin', 'superadmin'), invalidateCacheOnChange('cache:/api/submissions*'), async (req, res) => {
  try {
    const submission = await Submission.findById(req.params.id);
    if (!submission) {
      return res.status(404).json({
        success: false,
        message: 'Submission not found'
      });
    }

    if (req.user.role === 'admin' && !canAdminAccessSubmission(req.user, submission)) {
      return res.status(403).json({
        success: false,
        message: 'Not authorized to permanently delete this submission'
      });
    }

    if (!submission.isDeleted) {
      return res.status(400).json({
        success: false,
        message: 'Only soft-deleted submissions can be permanently deleted'
      });
    }

    await Submission.deleteOne({ _id: submission._id });

    await logger.logAdminAction(
      'Admin permanently deleted submission',
      req.user._id,
      req,
      {
        submissionId: submission._id.toString(),
        teacherId: submission.teacherId?.toString(),
        teacherName: submission.teacherName,
        level: submission.level,
        category: submission.category,
        subject: submission.subject
      },
      'error',
      'delete'
    );

    res.json({
      success: true,
      message: 'Submission permanently deleted successfully'
    });
  } catch (error) {
    console.error('Permanent delete submission error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
});

// @route   GET /api/submissions/leaderboard/council
// @desc    Get council level leaderboard (per area of focus and overall)
// @access  Private (Admin, Superadmin, Judge)
router.get('/leaderboard/council', authorize('admin', 'superadmin'), async (req, res) => {
  try {
    let { year, region, council, areaOfFocus, includeDisqualified = false } = req.query;

    // Admin scope: enforce region/council from scope for council/regional admins
    if (req.user.role === 'admin') {
      if (req.user.adminLevel === 'Council' && req.user.adminRegion && req.user.adminCouncil) {
        region = req.user.adminRegion;
        council = req.user.adminCouncil;
      } else if (req.user.adminLevel === 'Regional' && req.user.adminRegion) {
        region = req.user.adminRegion;
      }
    }

    // Build query for council level submissions
    const query = {
      level: 'Council',
      isDeleted: { $ne: true },
      status: { $in: ['evaluated', 'promoted', 'eliminated'] }
    };

    if (year) query.year = parseInt(year);
    if (region) query.region = region;
    if (council) query.council = council;
    if (areaOfFocus) query.areaOfFocus = areaOfFocus;

    // Exclude disqualified unless explicitly requested
    if (!includeDisqualified) {
      query.disqualified = { $ne: true };
    }

    // Get submissions sorted by average score (descending)
    let submissions = await Submission.find(query)
      .populate('teacherId', 'name email')
      .sort({ averageScore: -1, createdAt: 1 }); // Secondary sort by creation date for tie-breaking

    // Group by area of focus for per-area leaderboards
    const byAreaOfFocus = {};
    submissions.forEach(sub => {
      const area = sub.areaOfFocus || 'Unknown';
      if (!byAreaOfFocus[area]) {
        byAreaOfFocus[area] = [];
      }
      byAreaOfFocus[area].push(sub);
    });

    // Generate rankings
    const generateRankings = (subs) => {
      return subs.map((sub, index) => ({
        ...sub.toObject(),
        rank: index + 1,
        willAdvance: index < 3 && !sub.disqualified // Top 3 advance (if not disqualified)
      }));
    };

    // Per area of focus leaderboards
    const areaLeaderboards = {};
    Object.keys(byAreaOfFocus).forEach(area => {
      areaLeaderboards[area] = generateRankings(byAreaOfFocus[area]);
    });

    // Overall leaderboard (all areas combined)
    const overallLeaderboard = generateRankings(submissions);

    res.json({
      success: true,
      leaderboards: {
        byAreaOfFocus: areaLeaderboards,
        overall: overallLeaderboard
      },
      summary: {
        totalSubmissions: submissions.length,
        areasOfFocus: Object.keys(byAreaOfFocus),
        disqualified: submissions.filter(s => s.disqualified).length
      }
    });
  } catch (error) {
    console.error('Get council leaderboard error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
});

// @route   GET /api/submissions/leaderboard/regional
// @desc    Get regional level leaderboard
// @access  Private (Admin, Superadmin, Judge)
router.get('/leaderboard/regional', authorize('admin', 'superadmin'), async (req, res) => {
  try {
    let { year, region, areaOfFocus, includeDisqualified = false } = req.query;

    // Admin scope: enforce region from scope for regional admins
    if (req.user.role === 'admin' && req.user.adminLevel === 'Regional' && req.user.adminRegion) {
      region = req.user.adminRegion;
    }

    const query = {
      level: 'Regional',
      isDeleted: { $ne: true },
      status: { $in: ['evaluated', 'promoted', 'eliminated'] }
    };

    if (year) query.year = parseInt(year);
    if (region) query.region = region;
    if (areaOfFocus) query.areaOfFocus = areaOfFocus;

    if (!includeDisqualified) {
      query.disqualified = { $ne: true };
    }

    let submissions = await Submission.find(query)
      .populate('teacherId', 'name email')
      .sort({ averageScore: -1, createdAt: 1 });

    const byAreaOfFocus = {};
    submissions.forEach(sub => {
      const area = sub.areaOfFocus || 'Unknown';
      if (!byAreaOfFocus[area]) {
        byAreaOfFocus[area] = [];
      }
      byAreaOfFocus[area].push(sub);
    });

    const generateRankings = (subs) => {
      return subs.map((sub, index) => ({
        ...sub.toObject(),
        rank: index + 1,
        willAdvance: index < 3 && !sub.disqualified
      }));
    };

    const areaLeaderboards = {};
    Object.keys(byAreaOfFocus).forEach(area => {
      areaLeaderboards[area] = generateRankings(byAreaOfFocus[area]);
    });

    const overallLeaderboard = generateRankings(submissions);

    res.json({
      success: true,
      leaderboards: {
        byAreaOfFocus: areaLeaderboards,
        overall: overallLeaderboard
      },
      summary: {
        totalSubmissions: submissions.length,
        areasOfFocus: Object.keys(byAreaOfFocus),
        disqualified: submissions.filter(s => s.disqualified).length
      }
    });
  } catch (error) {
    console.error('Get regional leaderboard error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
});

// @route   GET /api/submissions/leaderboard/national
// @desc    Get national level leaderboard
// @access  Private (Admin, Superadmin, Judge)
router.get('/leaderboard/national', authorize('admin', 'superadmin'), async (req, res) => {
  try {
    const { year, areaOfFocus, includeDisqualified = false } = req.query;

    const query = {
      level: 'National',
      isDeleted: { $ne: true },
      status: { $in: ['evaluated', 'promoted', 'eliminated'] }
    };

    if (year) query.year = parseInt(year);
    if (areaOfFocus) query.areaOfFocus = areaOfFocus;

    if (!includeDisqualified) {
      query.disqualified = { $ne: true };
    }

    let submissions = await Submission.find(query)
      .populate('teacherId', 'name email')
      .sort({ averageScore: -1, createdAt: 1 });

    const byAreaOfFocus = {};
    submissions.forEach(sub => {
      const area = sub.areaOfFocus || 'Unknown';
      if (!byAreaOfFocus[area]) {
        byAreaOfFocus[area] = [];
      }
      byAreaOfFocus[area].push(sub);
    });

    const generateRankings = (subs) => {
      return subs.map((sub, index) => ({
        ...sub.toObject(),
        rank: index + 1
      }));
    };

    const areaLeaderboards = {};
    Object.keys(byAreaOfFocus).forEach(area => {
      areaLeaderboards[area] = generateRankings(byAreaOfFocus[area]);
    });

    const overallLeaderboard = generateRankings(submissions);

    res.json({
      success: true,
      leaderboards: {
        byAreaOfFocus: areaLeaderboards,
        overall: overallLeaderboard
      },
      summary: {
        totalSubmissions: submissions.length,
        areasOfFocus: Object.keys(byAreaOfFocus),
        disqualified: submissions.filter(s => s.disqualified).length
      }
    });
  } catch (error) {
    console.error('Get national leaderboard error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
});

// @route   GET /api/submissions/:id/eligible-judges
// @desc    Get eligible judges for a submission (Admin/Superadmin only)
// @access  Private (Admin, Superadmin)
router.get('/:id/eligible-judges', authorize('admin', 'superadmin'), async (req, res) => {
  try {
    const submission = await Submission.findOne({ _id: req.params.id, isDeleted: { $ne: true } });
    if (!submission) {
      return res.status(404).json({
        success: false,
        message: 'Submission not found'
      });
    }
    if (req.user.role === 'admin' && !canAdminAccessSubmission(req.user, submission)) {
      return res.status(403).json({
        success: false,
        message: 'Not authorized to access this submission'
      });
    }

    const result = await getEligibleJudges(req.params.id, {
      roundId: req.query.roundId || null
    });
    
    if (!result.success) {
      return res.status(404).json({
        success: false,
        message: result.error
      });
    }

    res.json({
      success: true,
      judges: result.judges,
      message: result.message || `${result.judges.length} eligible judge(s) found`
    });
  } catch (error) {
    console.error('Get eligible judges error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
});

// @route   GET /api/submissions/:id/assigned-judge
// @desc    Get assigned judge for a submission (Admin/Superadmin only)
// @access  Private (Admin, Superadmin)
router.get('/:id/assigned-judge', authorize('admin', 'superadmin'), async (req, res) => {
  try {
    const submission = await Submission.findOne({ _id: req.params.id, isDeleted: { $ne: true } });
    
    if (!submission) {
      return res.status(404).json({
        success: false,
        message: 'Submission not found'
      });
    }
    if (req.user.role === 'admin' && !canAdminAccessSubmission(req.user, submission)) {
      return res.status(403).json({
        success: false,
        message: 'Not authorized to access this submission'
      });
    }

    const includeHistorical = parseBooleanParam(req.query.includeHistorical);
    const assignmentResult = await getAssignedJudge(req.params.id, {
      roundId: req.query.roundId || null,
      includeHistorical,
      submission
    });

    if (!assignmentResult.success) {
      return res.status(400).json({
        success: false,
        message: assignmentResult.error || 'Failed to resolve assignment context'
      });
    }

    const assignment = assignmentResult.assignment;
    const assignments = assignmentResult.assignments || (assignment ? [assignment] : []);
    const resolvedRound = assignmentResult.round || assignment?.roundId || null;
    const serializeAssignment = (item) => ({
      assignmentId: item._id,
      judgeId: item.judgeId._id,
      judgeName: item.judgeId.name,
      judgeEmail: item.judgeId.email,
      assignedAt: item.assignedAt,
      roundId: item.roundId?._id || item.roundId || null,
      roundStatus: item.roundId?.status || resolvedRound?.status || null,
      isHistorical: assignmentResult.isHistorical === true
    });
    
    res.json({
      success: true,
      assignment: assignment ? serializeAssignment(assignment) : null,
      assignments: assignments.map(serializeAssignment),
      roundContext: resolvedRound ? {
        roundId: resolvedRound._id || resolvedRound,
        roundStatus: resolvedRound.status || null,
        isActionable: isRoundActionable(resolvedRound)
      } : null,
      message: assignment
        ? assignmentResult.isHistorical
          ? 'Historical judge assignment found'
          : `${assignments.length} judge assignment(s) found`
        : 'No judge assigned for the current round context'
    });
  } catch (error) {
    console.error('Get assigned judge error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
});

// @route   POST /api/submissions/:id/assign-judge
// @desc    Manually assign or reassign a submission to a judge (Admin/Superadmin only)
// @access  Private (Admin, Superadmin)
router.post(
  '/:id/assign-judge',
  authorize('admin', 'superadmin'),
  invalidateCacheOnChange(['cache:/api/submissions*', 'cache:/api/competition-rounds*']),
  async (req, res) => {
    try {
      const { judgeId } = req.body;

      if (!judgeId) {
        return res.status(400).json({
          success: false,
          message: 'Judge ID is required'
        });
      }

      const submission = await Submission.findOne({ _id: req.params.id, isDeleted: { $ne: true } });
      if (!submission) {
        return res.status(404).json({
          success: false,
          message: 'Submission not found'
        });
      }
      if (req.user.role === 'admin' && !canAdminAccessSubmission(req.user, submission)) {
        return res.status(403).json({
          success: false,
          message: 'Not authorized to access this submission'
        });
      }

      const judge = await User.findById(judgeId);
      if (!judge) {
        return res.status(404).json({
          success: false,
          message: 'Judge not found'
        });
      }
      if (req.user.role === 'admin' && !canAdminAccessUser(req.user, judge)) {
        return res.status(403).json({
          success: false,
          message: 'Not authorized to assign this judge'
        });
      }

      const roundResolution = await resolveSubmissionRoundContext(submission, {
        explicitRoundId: req.body.roundId || req.query.roundId || null,
        includeHistorical: false,
        allowFallbackByYearLevel: true
      });

      if (!roundResolution.round) {
        return res.status(400).json({
          success: false,
          message: 'No active or ended round found for this submission'
        });
      }

      const result = await manuallyAssignSubmission(req.params.id, judgeId, {
        roundId: roundResolution.round._id
      });

      if (!result.success) {
        return res.status(400).json({
          success: false,
          message: result.error
        });
      }

      // Log the assignment/reassignment
      await logger.logAdminAction(
        result.message.includes('reassigned') ? 'Admin reassigned submission to judge' : 'Admin assigned submission to judge',
        req.user._id,
        req,
        {
          submissionId: req.params.id,
          judgeId: judgeId,
          assignmentId: result.assignment._id.toString()
        },
        'success',
        'update'
      );

      res.json({
        success: true,
        assignment: {
          id: result.assignment._id,
          submissionId: result.assignment.submissionId,
          judgeId: result.assignment.judgeId,
          assignedAt: result.assignment.assignedAt,
          roundId: result.assignment.roundId,
          roundStatus: roundResolution.round.status
        },
        message: result.message
      });
    } catch (error) {
      console.error('Assign judge error:', error);
      res.status(500).json({
        success: false,
        message: error.message || 'Server error'
      });
    }
  }
);

module.exports = router;
