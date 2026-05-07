const User = require('../models/User');
const Submission = require('../models/Submission');
const SubmissionAssignment = require('../models/SubmissionAssignment');
const CompetitionRound = require('../models/CompetitionRound');
const RoundChunk = require('../models/RoundChunk');
const notificationService = require('../services/notificationService');
const {
  buildCaseInsensitiveExactRegex,
  locationsEqual,
  resolveSubmissionRoundContext,
  isRoundActionable,
  isRoundHistorical
} = require('./roundContext');

const ACTIONABLE_ASSIGNMENT_STATUSES = new Set(['pending', 'submitted', 'under_review', 'evaluated']);

const isDuplicateKeyError = (error) => {
  return Boolean(error && (error.code === 11000 || error?.cause?.code === 11000));
};

const normalizeAreaOfFocus = (value) => String(value || '')
  .normalize('NFKD')
  .replace(/[\u0300-\u036f]/g, '')
  .replace(/[^a-zA-Z0-9]+/g, ' ')
  .trim()
  .toLowerCase();

const judgeMatchesAreaOfFocus = (judge, submissionAreaOfFocus) => {
  const normalizedSubmissionAreaOfFocus = normalizeAreaOfFocus(submissionAreaOfFocus);
  if (!normalizedSubmissionAreaOfFocus) return true;
  if (!Array.isArray(judge?.areasOfFocus) || judge.areasOfFocus.length === 0) return false;
  return judge.areasOfFocus.some(
    (focus) => normalizeAreaOfFocus(focus) === normalizedSubmissionAreaOfFocus
  );
};

const buildSubmissionAreaQueryByLevel = (level, region, council) => {
  if (level === 'Council') {
    return { region, council };
  }
  if (level === 'Regional') {
    return { region };
  }
  return {};
};

const buildJudgeAreaQueryByLevel = (level, region, council) => {
  if (level === 'Council') {
    const regionRegex = buildCaseInsensitiveExactRegex(region);
    const councilRegex = buildCaseInsensitiveExactRegex(council);
    if (!regionRegex || !councilRegex) return null;
    return {
      assignedRegion: regionRegex,
      assignedCouncil: councilRegex
    };
  }
  if (level === 'Regional') {
    const regionRegex = buildCaseInsensitiveExactRegex(region);
    if (!regionRegex) return null;
    return {
      assignedRegion: regionRegex
    };
  }
  return {};
};

const isSubmissionActionableForAssignment = (submission) => {
  if (!submission) return false;
  if (submission.disqualified) return false;
  return ACTIONABLE_ASSIGNMENT_STATUSES.has(submission.status);
};

const resolveActionableRoundForSubmission = async (submission, explicitRoundId = null) => {
  const context = await resolveSubmissionRoundContext(submission, {
    explicitRoundId,
    includeHistorical: false,
    allowFallbackByYearLevel: true
  });

  if (!context.round) {
    return {
      round: null,
      reason: context.reason || 'round_not_found'
    };
  }

  if (!isRoundActionable(context.round)) {
    return {
      round: null,
      reason: 'round_not_actionable'
    };
  }

  return {
    round: context.round,
    reason: null
  };
};

const isSubmissionEligibleForRoundChunkSchedule = async (submission, round) => {
  if (!submission || !round) return false;
  if (!['Council', 'Regional'].includes(round.level)) return true;

  const areaType = round.level === 'Council' ? 'council' : 'region';
  const chunks = await RoundChunk.find({
    roundId: round._id,
    areaType,
    isActive: true
  }).select('areas scheduledActivationTime scheduledEndTime');

  // No configured chunks means no chunk-based restrictions.
  if (!chunks || chunks.length === 0) return true;

  const areaId = round.level === 'Council'
    ? `${submission.region || ''}::${submission.council || ''}`
    : (submission.region || '');

  const chunk = chunks.find((item) => Array.isArray(item.areas) && item.areas.includes(areaId));
  if (!chunk) {
    return false;
  }

  const now = new Date();
  if (chunk.scheduledActivationTime) {
    const activationTime = new Date(chunk.scheduledActivationTime);
    if (!Number.isNaN(activationTime.getTime()) && activationTime > now) {
      return false;
    }
  }
  if (chunk.scheduledEndTime) {
    const endTime = new Date(chunk.scheduledEndTime);
    if (!Number.isNaN(endTime.getTime()) && endTime <= now) {
      return false;
    }
  }
  return true;
};

/**
 * Assign a judge to a submission using round-robin algorithm.
 * Only for Council and Regional levels.
 *
 * @param {Object} submission - Submission document
 * @param {Object} options - { roundId }
 */
async function assignJudgeToSubmission(submission, options = {}) {
  try {
    if (!submission) {
      return { success: false, assignment: null, error: 'Submission is required' };
    }

    if (submission.level === 'National') {
      return {
        success: true,
        assignment: null,
        message: 'National level does not require assignment'
      };
    }

    if (!isSubmissionActionableForAssignment(submission)) {
      return {
        success: false,
        assignment: null,
        error: `Submission status "${submission.status}" is not eligible for assignment`
      };
    }

    const roundResolution = await resolveActionableRoundForSubmission(submission, options.roundId || null);
    if (!roundResolution.round) {
      return {
        success: false,
        assignment: null,
        error: 'No active or ended round found for this submission level'
      };
    }

    const round = roundResolution.round;
    const chunkEligible = await isSubmissionEligibleForRoundChunkSchedule(submission, round);
    if (!chunkEligible) {
      return {
        success: false,
        assignment: null,
        error: 'Submission area is not active for assignment in this round chunk schedule'
      };
    }
    const roundId = round._id;

    if (!submission.roundId || String(submission.roundId) !== String(roundId)) {
      await Submission.updateOne({ _id: submission._id }, { $set: { roundId } });
      submission.roundId = roundId;
    }

    const existingAssignment = await SubmissionAssignment.findOne({
      roundId,
      submissionId: submission._id
    });

    if (existingAssignment) {
      return {
        success: true,
        assignment: existingAssignment,
        message: 'Submission already assigned for this round'
      };
    }

    const assignmentLevel = round.level || submission.level;
    const assignmentCouncil = assignmentLevel === 'Council' ? submission.council : null;

    const areaQuery = buildJudgeAreaQueryByLevel(assignmentLevel, submission.region, assignmentCouncil);
    if (areaQuery === null) {
      return {
        success: false,
        assignment: null,
        error: 'Submission location is incomplete for judge assignment'
      };
    }

    const judgeQuery = {
      role: 'judge',
      status: 'active',
      assignedLevel: assignmentLevel,
      ...areaQuery
    };

    const availableJudges = await User.find(judgeQuery).select('_id name email areasOfFocus');
    const submissionAreaOfFocus = submission.areaOfFocus || '';
    const scopedAvailableJudges = availableJudges.filter((judge) =>
      judgeMatchesAreaOfFocus(judge, submissionAreaOfFocus)
    );

    if (scopedAvailableJudges.length === 0) {
      return {
        success: false,
        assignment: null,
        error: `No active judges found for ${assignmentLevel} level at ${submission.region}${assignmentCouncil ? ` - ${assignmentCouncil}` : ''} with area of focus "${submissionAreaOfFocus || 'N/A'}"`
      };
    }

    const locationAssignmentQuery = {
      roundId,
      level: assignmentLevel,
      region: submission.region,
      ...(assignmentLevel === 'Council' ? { council: assignmentCouncil } : {})
    };

    const existingAssignments = await SubmissionAssignment.find(locationAssignmentQuery).select('judgeId');

    const assignmentCounts = {};
    scopedAvailableJudges.forEach((judge) => {
      assignmentCounts[judge._id.toString()] = 0;
    });

    existingAssignments.forEach((assignment) => {
      const judgeId = assignment.judgeId.toString();
      if (assignmentCounts[judgeId] !== undefined) {
        assignmentCounts[judgeId] += 1;
      }
    });

    let selectedJudge = scopedAvailableJudges[0];
    let minCount = assignmentCounts[selectedJudge._id.toString()];

    for (const judge of scopedAvailableJudges) {
      const count = assignmentCounts[judge._id.toString()];
      if (count < minCount) {
        minCount = count;
        selectedJudge = judge;
      }
    }

    let assignment;
    try {
      assignment = await SubmissionAssignment.create({
        roundId,
        submissionId: submission._id,
        judgeId: selectedJudge._id,
        level: assignmentLevel,
        region: submission.region,
        council: assignmentCouncil || null,
        judgeNotified: false
      });
    } catch (error) {
      if (!isDuplicateKeyError(error)) {
        throw error;
      }

      const concurrentAssignment = await SubmissionAssignment.findOne({
        roundId,
        submissionId: submission._id
      });

      if (concurrentAssignment) {
        return {
          success: true,
          assignment: concurrentAssignment,
          message: 'Submission already assigned for this round'
        };
      }

      throw error;
    }

    notificationService.handleJudgeAssigned({
      userId: selectedJudge._id.toString(),
      submissionId: submission._id.toString(),
      teacherName: submission.teacherName,
      subject: submission.subject,
      areaOfFocus: submission.areaOfFocus,
      level: assignmentLevel,
      region: submission.region,
      council: assignmentCouncil
    }).catch((error) => {
      console.error('Error sending judge assignment notification:', error);
    });

    assignment.judgeNotified = true;
    await assignment.save();

    return {
      success: true,
      assignment,
      judge: selectedJudge,
      roundId: roundId.toString()
    };
  } catch (error) {
    console.error('Error assigning judge to submission:', error);
    return {
      success: false,
      assignment: null,
      error: error.message
    };
  }
}

/**
 * Get assigned judge for a submission.
 * If roundId is not provided, returns the latest assignment.
 */
async function getAssignedJudge(submissionId, roundId = null) {
  const options = (roundId && typeof roundId === 'object')
    ? roundId
    : { roundId };

  try {
    const submission = options.submission || await Submission.findById(submissionId).select('_id year level roundId');
    if (!submission) {
      return {
        success: false,
        assignment: null,
        round: null,
        isHistorical: false,
        error: 'Submission not found'
      };
    }

    const includeHistorical = options.includeHistorical === true;

    const context = await resolveSubmissionRoundContext(submission, {
      explicitRoundId: options.roundId || null,
      includeHistorical,
      allowFallbackByYearLevel: true
    });

    let assignment = null;
    let resolvedRound = context.round || null;

    if (resolvedRound) {
      assignment = await SubmissionAssignment.findOne({
        submissionId,
        roundId: resolvedRound._id
      })
        .populate('judgeId', 'name email username')
        .populate('roundId', 'year level status');
    }

    if (!assignment && includeHistorical) {
      assignment = await SubmissionAssignment.findOne({ submissionId })
        .sort({ createdAt: -1 })
        .populate('judgeId', 'name email username')
        .populate('roundId', 'year level status');
      resolvedRound = assignment?.roundId || resolvedRound;
    }

    return {
      success: true,
      assignment,
      round: resolvedRound,
      source: context.source,
      isHistorical: isRoundHistorical(resolvedRound),
      error: null
    };
  } catch (error) {
    console.error('Error getting assigned judge:', error);
    return {
      success: false,
      assignment: null,
      round: null,
      isHistorical: false,
      error: error.message
    };
  }
}

/**
 * Check if a judge is assigned to a submission in a round.
 */
async function isJudgeAssigned(submissionId, judgeId, roundId = null) {
  try {
    const query = { submissionId, judgeId };
    if (roundId) query.roundId = roundId;

    const assignment = await SubmissionAssignment.findOne(query).select('_id');
    return !!assignment;
  } catch (error) {
    console.error('Error checking judge assignment:', error);
    return false;
  }
}

/**
 * Resolve whether a judge can evaluate a submission in the resolved active round context.
 * Strict check: assignment exists for submission + judge + round.
 * Visibility-aligned fallback: assignment exists for submission + judge in any round.
 */
async function resolveJudgeEvaluationAuthorization(submissionId, judgeId, roundId = null, options = {}) {
  const { allowVisibleAssignmentFallback = true } = options;

  try {
    if (roundId) {
      const strictAssignment = await SubmissionAssignment.findOne({
        submissionId,
        judgeId,
        roundId
      }).select('_id roundId');

      if (strictAssignment) {
        return {
          success: true,
          authorized: true,
          source: 'strict_round_assignment',
          assignmentRoundId: strictAssignment.roundId || roundId
        };
      }
    }

    if (!allowVisibleAssignmentFallback) {
      return {
        success: true,
        authorized: false,
        source: 'none',
        assignmentRoundId: null
      };
    }

    const fallbackAssignment = await SubmissionAssignment.findOne({
      submissionId,
      judgeId
    })
      .sort({ assignedAt: -1, createdAt: -1 })
      .select('_id roundId');

    if (fallbackAssignment) {
      return {
        success: true,
        authorized: true,
        source: 'visible_assignment_fallback',
        assignmentRoundId: fallbackAssignment.roundId || null
      };
    }

    return {
      success: true,
      authorized: false,
      source: 'none',
      assignmentRoundId: null
    };
  } catch (error) {
    console.error('Error resolving judge evaluation authorization:', error);
    return {
      success: false,
      authorized: false,
      source: 'error',
      assignmentRoundId: null,
      error: error.message
    };
  }
}

/**
 * Assign pending submissions from active rounds to judges in the same location.
 * This is useful when a new judge is created.
 */
async function assignUnassignedSubmissionsToJudge(judge) {
  try {
    if (!judge || !judge.assignedLevel || judge.assignedLevel === 'National') {
      return { success: true, assignedCount: 0, message: 'No round-scoped assignment required' };
    }

    const rounds = await CompetitionRound.find({
      level: judge.assignedLevel,
      status: 'active'
    }).select('_id year level pendingSubmissionsSnapshot');

    if (rounds.length === 0) {
      return { success: true, assignedCount: 0, message: 'No active rounds found for judge level' };
    }

    let assignedCount = 0;
    for (const round of rounds) {
      const areaQuery = buildSubmissionAreaQueryByLevel(
        judge.assignedLevel,
        judge.assignedRegion,
        judge.assignedCouncil
      );

      const submissions = await Submission.find({
        _id: { $in: round.pendingSubmissionsSnapshot || [] },
        level: judge.assignedLevel,
        ...areaQuery,
        status: { $nin: ['promoted', 'eliminated'] }
      });

      for (const submission of submissions) {
        const existing = await SubmissionAssignment.findOne({
          roundId: round._id,
          submissionId: submission._id
        }).select('_id');

        if (existing) continue;

        const assignmentResult = await assignJudgeToSubmission(submission, { roundId: round._id });
        if (assignmentResult.success && assignmentResult.assignment) {
          assignedCount += 1;
        }
      }
    }

    return {
      success: true,
      assignedCount,
      message: `Assigned ${assignedCount} submission(s) across active rounds`
    };
  } catch (error) {
    console.error('Error assigning unassigned submissions to judge:', error);
    return {
      success: false,
      assignedCount: 0,
      error: error.message
    };
  }
}

/**
 * Manually assign or reassign a submission to a specific judge.
 * @param {ObjectId} submissionId
 * @param {ObjectId} judgeId
 * @param {Object} options - { roundId }
 */
async function manuallyAssignSubmission(submissionId, judgeId, options = {}) {
  try {
    const submission = await Submission.findById(submissionId);
    if (!submission) {
      return { success: false, assignment: null, error: 'Submission not found' };
    }

    if (submission.level === 'National') {
      return { success: false, assignment: null, error: 'National level does not require assignment' };
    }

    if (!isSubmissionActionableForAssignment(submission)) {
      return {
        success: false,
        assignment: null,
        error: `Submission status "${submission.status}" is not eligible for assignment`
      };
    }

    const roundResolution = await resolveActionableRoundForSubmission(submission, options.roundId || null);
    if (!roundResolution.round) {
      return { success: false, assignment: null, error: 'No active or ended round found for this submission level' };
    }

    const round = roundResolution.round;
    const assignmentLevel = round.level || submission.level;
    const assignmentCouncil = assignmentLevel === 'Council' ? submission.council : null;
    const chunkEligible = await isSubmissionEligibleForRoundChunkSchedule(submission, round);
    if (!chunkEligible) {
      return {
        success: false,
        assignment: null,
        error: 'Submission area is not active for assignment in this round chunk schedule'
      };
    }

    const judge = await User.findById(judgeId);
    if (!judge || judge.role !== 'judge' || judge.status !== 'active') {
      return { success: false, assignment: null, error: 'Invalid or inactive judge' };
    }

    if (judge.assignedLevel !== assignmentLevel) {
      return { success: false, assignment: null, error: 'Judge level does not match round assignment level' };
    }

    if (assignmentLevel === 'Council') {
      if (!locationsEqual(judge.assignedRegion, submission.region) || !locationsEqual(judge.assignedCouncil, assignmentCouncil)) {
        return { success: false, assignment: null, error: 'Judge location does not match submission council scope' };
      }
    } else if (assignmentLevel === 'Regional') {
      if (!locationsEqual(judge.assignedRegion, submission.region)) {
        return { success: false, assignment: null, error: 'Judge region does not match submission region' };
      }
    }

    if (!judgeMatchesAreaOfFocus(judge, submission.areaOfFocus || '')) {
      return { success: false, assignment: null, error: 'Judge area of focus does not match submission area of focus' };
    }

    if (!submission.roundId || String(submission.roundId) !== String(round._id)) {
      await Submission.updateOne({ _id: submissionId }, { $set: { roundId: round._id } });
      submission.roundId = round._id;
    }

    const assignmentQuery = {
      roundId: round._id,
      submissionId
    };

    let assignment = await SubmissionAssignment.findOne(assignmentQuery);
    let message = 'Submission assigned successfully';

    if (assignment) {
      assignment.judgeId = judgeId;
      assignment.judgeNotified = false;
      await assignment.save();
      message = 'Submission reassigned successfully';
    } else {
      try {
        assignment = await SubmissionAssignment.create({
          roundId: round._id,
          submissionId,
          judgeId,
          level: assignmentLevel,
          region: submission.region,
          council: assignmentCouncil || null,
          judgeNotified: false
        });
      } catch (error) {
        if (!isDuplicateKeyError(error)) {
          throw error;
        }

        assignment = await SubmissionAssignment.findOne(assignmentQuery);
        if (!assignment) {
          throw error;
        }

        assignment.judgeId = judgeId;
        assignment.judgeNotified = false;
        await assignment.save();
        message = 'Submission reassigned successfully';
      }
    }

    notificationService.handleJudgeAssigned({
      userId: judgeId.toString(),
      submissionId: submissionId.toString(),
      teacherName: submission.teacherName,
      subject: submission.subject,
      areaOfFocus: submission.areaOfFocus,
      level: assignmentLevel,
      region: submission.region,
      council: assignmentCouncil
    }).catch((error) => {
      console.error('Error sending judge assignment notification:', error);
    });

    return {
      success: true,
      assignment,
      message,
      roundId: round._id.toString()
    };
  } catch (error) {
    console.error('Error manually assigning submission:', error);
    return {
      success: false,
      assignment: null,
      error: error.message
    };
  }
}

/**
 * Get eligible judges for a submission.
 */
async function getEligibleJudges(submissionId, options = {}) {
  try {
    const submission = await Submission.findById(submissionId).select('_id year level roundId region council status disqualified areaOfFocus');

    if (!submission) {
      return { success: false, judges: [], error: 'Submission not found' };
    }

    const roundResolution = await resolveActionableRoundForSubmission(submission, options.roundId || null);
    if (!roundResolution.round) {
      return {
        success: true,
        judges: [],
        message: 'No active or ended round found for this submission level'
      };
    }

    const assignmentLevel = roundResolution.round.level || submission.level;
    const assignmentCouncil = assignmentLevel === 'Council' ? submission.council : null;

    if (assignmentLevel === 'National') {
      return {
        success: true,
        judges: [],
        message: 'National level does not require assignment'
      };
    }

    if (!isSubmissionActionableForAssignment(submission)) {
      return {
        success: true,
        judges: [],
        message: `Submission status "${submission.status}" is not eligible for assignment`
      };
    }

    const areaQuery = buildJudgeAreaQueryByLevel(assignmentLevel, submission.region, assignmentCouncil);
    if (areaQuery === null) {
      return {
        success: true,
        judges: [],
        message: 'Submission location is incomplete for judge assignment'
      };
    }

    const judgeQuery = {
      role: 'judge',
      status: 'active',
      assignedLevel: assignmentLevel,
      ...areaQuery
    };

    const judges = await User.find(judgeQuery)
      .select('_id name email username assignedLevel assignedRegion assignedCouncil areasOfFocus')
      .sort({ name: 1 });

    const eligibleJudges = judges.filter((judge) =>
      judgeMatchesAreaOfFocus(judge, submission.areaOfFocus || '')
    );

    return { success: true, judges: eligibleJudges };
  } catch (error) {
    console.error('Error getting eligible judges:', error);
    return {
      success: false,
      judges: [],
      error: error.message
    };
  }
}

module.exports = {
  assignJudgeToSubmission,
  getAssignedJudge,
  isJudgeAssigned,
  resolveJudgeEvaluationAuthorization,
  assignUnassignedSubmissionsToJudge,
  manuallyAssignSubmission,
  getEligibleJudges
};
