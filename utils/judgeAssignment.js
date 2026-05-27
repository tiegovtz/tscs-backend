const User = require('../models/User');
const Submission = require('../models/Submission');
const SubmissionAssignment = require('../models/SubmissionAssignment');
const CompetitionRound = require('../models/CompetitionRound');
const RoundChunk = require('../models/RoundChunk');
const RoundSnapshot = require('../models/RoundSnapshot');
const PromotionRecord = require('../models/PromotionRecord');
const notificationService = require('../services/notificationService');
const {
  buildCaseInsensitiveExactRegex,
  locationsEqual,
  resolveSubmissionRoundContext,
  isRoundActionable,
  isRoundHistorical
} = require('./roundContext');
const { getCanonicalAreaOfFocusLabel } = require('./areaOfFocus');

const ACTIONABLE_ASSIGNMENT_STATUSES = new Set(['pending', 'submitted', 'under_review', 'evaluated']);
const LEGACY_GLOBAL_SUBMISSION_INDEX = 'submissionId_1';
const LEGACY_SINGLE_ASSIGNMENT_INDEX = 'roundId_1_submissionId_1';
const UNIQUE_JUDGE_ASSIGNMENT_INDEX = 'roundId_1_submissionId_1_judgeId_1';
const UNIQUE_SCOPED_ASSIGNMENT_INDEX = 'roundId_1_submissionId_1_level_1';

const isDuplicateKeyError = (error) => {
  return Boolean(error && (error.code === 11000 || error?.cause?.code === 11000));
};

const isLegacyAssignmentIndexError = (error) => {
  if (!isDuplicateKeyError(error)) return false;
  const message = String(error.message || '');
  const keyPattern = error.keyPattern || error?.cause?.keyPattern || {};
  return message.includes(`index: ${LEGACY_GLOBAL_SUBMISSION_INDEX}`)
    || message.includes(`index: ${LEGACY_SINGLE_ASSIGNMENT_INDEX}`)
    || (
      keyPattern.submissionId === 1
      && !Object.prototype.hasOwnProperty.call(keyPattern, 'roundId')
      && !Object.prototype.hasOwnProperty.call(keyPattern, 'judgeId')
    )
    || (
      keyPattern.roundId === 1
      && keyPattern.submissionId === 1
      && !Object.prototype.hasOwnProperty.call(keyPattern, 'judgeId')
    );
};

const getSubmissionAssignmentIndexes = async () => {
  try {
    return await SubmissionAssignment.collection.indexes();
  } catch (error) {
    if (error.code === 26 || error.codeName === 'NamespaceNotFound') {
      return [];
    }
    throw error;
  }
};

const dropIndexIfPresent = async (indexName) => {
  try {
    await SubmissionAssignment.collection.dropIndex(indexName);
    return true;
  } catch (error) {
    if (
      error.code === 26
      || error.code === 27
      || error.codeName === 'NamespaceNotFound'
      || error.codeName === 'IndexNotFound'
    ) {
      return false;
    }
    throw error;
  }
};

const ensureAssignmentIndex = async (key, options) => {
  const indexName = options.name;
  const indexes = await getSubmissionAssignmentIndexes();
  const existing = indexes.find((index) => index.name === indexName);
  const expectedPartial = options.partialFilterExpression
    ? JSON.stringify(options.partialFilterExpression)
    : null;
  const existingPartial = existing?.partialFilterExpression
    ? JSON.stringify(existing.partialFilterExpression)
    : null;

  if (
    existing
    && Boolean(existing.unique) === Boolean(options.unique)
    && expectedPartial === existingPartial
  ) {
    return;
  }

  if (existing) {
    await dropIndexIfPresent(indexName);
  }

  await SubmissionAssignment.collection.createIndex(key, options);
};

const repairSubmissionAssignmentIndexes = async () => {
  try {
    const droppedGlobal = await dropIndexIfPresent(LEGACY_GLOBAL_SUBMISSION_INDEX);
    const droppedLegacy = await dropIndexIfPresent(LEGACY_SINGLE_ASSIGNMENT_INDEX);
    await ensureAssignmentIndex(
      { roundId: 1, submissionId: 1, judgeId: 1 },
      { name: UNIQUE_JUDGE_ASSIGNMENT_INDEX, unique: true }
    );
    await ensureAssignmentIndex(
      { roundId: 1, submissionId: 1, level: 1 },
      {
        name: UNIQUE_SCOPED_ASSIGNMENT_INDEX,
        unique: true,
        partialFilterExpression: { level: { $in: ['Council', 'Regional'] } }
      }
    );
    if (droppedGlobal) {
      console.warn(`Dropped legacy submission assignment index: ${LEGACY_GLOBAL_SUBMISSION_INDEX}`);
    }
    if (droppedLegacy) {
      console.warn(`Dropped legacy submission assignment index: ${LEGACY_SINGLE_ASSIGNMENT_INDEX}`);
    }
    return droppedGlobal || droppedLegacy;
  } catch (error) {
    if (
      error.code === 26
      || error.code === 27
      || error.codeName === 'NamespaceNotFound'
      || error.codeName === 'IndexNotFound'
    ) {
      return false;
    }
    throw error;
  }
};

let assignmentIndexesEnsured = false;
let ensureAssignmentIndexesPromise = null;
const ensureSubmissionAssignmentIndexesReady = async ({ force = false } = {}) => {
  if (!force && assignmentIndexesEnsured) {
    return { success: true, changed: false, skipped: true };
  }
  if (!force && ensureAssignmentIndexesPromise) {
    return ensureAssignmentIndexesPromise;
  }

  const execution = (async () => {
    const changed = await repairSubmissionAssignmentIndexes();
    assignmentIndexesEnsured = true;
    return { success: true, changed, skipped: false };
  })();

  if (!force) {
    ensureAssignmentIndexesPromise = execution.finally(() => {
      ensureAssignmentIndexesPromise = null;
    });
    return ensureAssignmentIndexesPromise;
  }

  return execution;
};

const createSubmissionAssignment = async (data) => {
  try {
    return await SubmissionAssignment.create(data);
  } catch (error) {
    if (!isLegacyAssignmentIndexError(error)) {
      throw error;
    }

    await ensureSubmissionAssignmentIndexesReady({ force: true });
    return SubmissionAssignment.create(data);
  }
};

const normalizeAreaOfFocus = (value) => String(getCanonicalAreaOfFocusLabel(value) || '')
  .normalize('NFKD')
  .replace(/[\u0300-\u036f]/g, '')
  .replace(/[^a-zA-Z0-9]+/g, ' ')
  .trim()
  .toLowerCase();

const judgeMatchesAreaOfFocus = (judge, submissionAreaOfFocus) => {
  const normalizedSubmissionAreaOfFocus = normalizeAreaOfFocus(submissionAreaOfFocus);
  if (!normalizedSubmissionAreaOfFocus) return true;
  if (!Array.isArray(judge?.areasOfFocus) || judge.areasOfFocus.length === 0) return true;
  return judge.areasOfFocus.some(
    (focus) => normalizeAreaOfFocus(focus) === normalizedSubmissionAreaOfFocus
  );
};

const isFaceToFaceNationalRound = (round) => (
  String(round?.level || '') === 'National'
  && String(round?.stage || '') === 'face_to_face'
);

const buildEligibleJudgeEmptyMessage = ({ assignmentLevel, submission, totalScopedJudges, eligibleCount }) => {
  if (eligibleCount > 0) {
    return `${eligibleCount} eligible judge(s) found`;
  }

  const location = assignmentLevel === 'Council'
    ? `${submission.region || 'Unknown region'} - ${submission.council || 'Unknown council'}`
    : assignmentLevel === 'Regional'
      ? (submission.region || 'Unknown region')
      : 'National';

  if (totalScopedJudges === 0) {
    return `No active ${assignmentLevel} judges found for ${location}`;
  }

  return `No active ${assignmentLevel} judges in ${location} match area of focus "${submission.areaOfFocus || 'N/A'}"`;
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

const buildRoundAreaDescriptor = (round, submission) => {
  const level = round?.level || submission?.level;
  if (level === 'Council') {
    return {
      areaType: 'council',
      areaId: `${submission.region || 'unknown'}::${submission.council || 'unknown'}`,
      region: submission.region || null,
      council: submission.council || null
    };
  }
  if (level === 'Regional') {
    return {
      areaType: 'region',
      areaId: submission.region || 'unknown',
      region: submission.region || null,
      council: null
    };
  }
  return {
    areaType: 'national',
    areaId: 'national',
    region: null,
    council: null
  };
};

const ensureSubmissionInRoundSnapshot = async (submission, round) => {
  if (!submission || !round || !['active', 'ended'].includes(round.status)) {
    return { attached: false, reason: 'round_not_actionable' };
  }

  const submissionId = String(submission._id);
  const snapshot = await RoundSnapshot.findOne({ roundId: round._id });
  const existingIds = new Set([
    ...((round.pendingSubmissionsSnapshot || []).map((id) => String(id))),
    ...((snapshot?.submissionIds || []).map((id) => String(id)))
  ]);

  if (existingIds.has(submissionId)) {
    if (!submission.roundId || String(submission.roundId) !== String(round._id)) {
      await Submission.updateOne({ _id: submission._id }, { $set: { roundId: round._id } });
      submission.roundId = round._id;
    }
    return { attached: false, alreadyExists: true };
  }

  const descriptor = buildRoundAreaDescriptor(round, submission);
  const areaMap = new Map();
  const baseAreas = Array.isArray(snapshot?.activeAreas) && snapshot.activeAreas.length > 0
    ? snapshot.activeAreas
    : (round.activeAreas || []);

  for (const area of baseAreas) {
    if (!area?.areaId) continue;
    areaMap.set(String(area.areaId), {
      areaType: area.areaType,
      areaId: area.areaId,
      region: area.region || null,
      council: area.council || null,
      submissionCount: Number(area.submissionCount) || 0
    });
  }

  const currentArea = areaMap.get(descriptor.areaId) || {
    areaType: descriptor.areaType,
    areaId: descriptor.areaId,
    region: descriptor.region,
    council: descriptor.council,
    submissionCount: 0
  };
  currentArea.submissionCount += 1;
  areaMap.set(descriptor.areaId, currentArea);

  const updatedIds = [...existingIds, submissionId];
  const updatedSnapshot = await RoundSnapshot.findOneAndUpdate(
    { roundId: round._id },
    {
      roundId: round._id,
      year: round.year,
      level: round.level,
      submissionIds: updatedIds,
      activeAreas: [...areaMap.values()],
      totalSubmissions: updatedIds.length,
      frozenAt: snapshot?.frozenAt || round.snapshotCreatedAt || new Date(),
      metadata: {
        ...(snapshot?.metadata || {}),
        lastManualAssignmentAttachmentAt: new Date(),
        lastManualAssignmentSubmissionId: submission._id
      }
    },
    { upsert: true, new: true, runValidators: true }
  );

  await Submission.updateOne({ _id: submission._id }, { $set: { roundId: round._id } });
  submission.roundId = round._id;

  round.pendingSubmissionsSnapshot = updatedSnapshot.submissionIds || [];
  round.activeAreas = updatedSnapshot.activeAreas || [];
  if (!round.activationSnapshotId) {
    round.activationSnapshotId = updatedSnapshot._id;
  }
  if (!round.snapshotCreatedAt) {
    round.snapshotCreatedAt = new Date();
  }
  await round.save();

  return { attached: true, snapshot: updatedSnapshot };
};

const getNationalRoundSubmissionIds = async (round) => {
  const snapshot = await RoundSnapshot.findOne({ roundId: round._id }).select('submissionIds');
  return [
    ...new Set([
      ...((round.pendingSubmissionsSnapshot || []).map((id) => String(id))),
      ...((snapshot?.submissionIds || []).map((id) => String(id)))
    ])
  ];
};

const getNationalAreaSubmissionsForAssignment = async (round, sourceSubmission) => {
  const submissionIds = await getNationalRoundSubmissionIds(round);
  const query = {
    year: sourceSubmission.year,
    level: 'National',
    isDeleted: { $ne: true },
    disqualified: { $ne: true },
    status: { $nin: ['promoted', 'eliminated', 'disqualified'] }
  };

  if (submissionIds.length > 0) {
    query._id = { $in: submissionIds };
  }

  const normalizedAreaOfFocus = normalizeAreaOfFocus(sourceSubmission.areaOfFocus || '');
  const submissions = await Submission.find(query).select('_id areaOfFocus region council status disqualified');
  return submissions.filter((submission) =>
    normalizeAreaOfFocus(submission.areaOfFocus || '') === normalizedAreaOfFocus
  );
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

const isSubmissionStatusActionableForAssignment = (submission) => {
  if (!submission) return false;
  if (submission.disqualified) return false;
  return ACTIONABLE_ASSIGNMENT_STATUSES.has(submission.status);
};

const ensureSubmissionActionableForAssignment = async (submission, round, options = {}) => {
  const { allowDisqualified = false } = options;

  if (!submission) {
    return { actionable: false, status: null };
  }

  if (submission.disqualified) {
    return allowDisqualified
      ? { actionable: true, status: submission.status, disqualified: true }
      : { actionable: false, status: submission.status };
  }

  if (submission.status === 'disqualified') {
    return allowDisqualified
      ? { actionable: true, status: submission.status, disqualified: true }
      : { actionable: false, status: submission.status };
  }

  if (isSubmissionStatusActionableForAssignment(submission)) {
    return { actionable: true, status: submission.status };
  }

  if (
    submission.status !== 'eliminated'
    || !round
    || String(submission.level || '') !== String(round.level || '')
  ) {
    return { actionable: false, status: submission.status };
  }

  const [promotionIntoCurrentLevel, currentLevelDecision] = await Promise.all([
    PromotionRecord.findOne({
      submissionId: submission._id,
      status: 'promoted',
      $or: [
        { toLevel: submission.level },
        { toRoundId: round._id },
        ...(submission.promotedFromRoundId ? [{ fromRoundId: submission.promotedFromRoundId }] : [])
      ]
    }).select('_id'),
    PromotionRecord.findOne({
      submissionId: submission._id,
      fromLevel: submission.level,
      status: { $in: ['promoted', 'eliminated'] }
    }).select('_id')
  ]);

  if (currentLevelDecision) {
    return { actionable: false, status: submission.status };
  }

  const isPromotedIntoCurrentRound = Boolean(promotionIntoCurrentLevel)
    || (submission.promotedFromRoundId && String(submission.level || '') !== 'Council')
    || (String(round.status || '') === 'active' && ['Regional', 'National'].includes(String(round.level || '')));
  if (!isPromotedIntoCurrentRound) {
    return { actionable: false, status: submission.status };
  }

  await Submission.updateOne(
    { _id: submission._id, status: 'eliminated' },
    { $set: { status: 'submitted' } }
  );
  submission.status = 'submitted';

  return { actionable: true, status: submission.status, repaired: true };
};

const resolveActionableRoundForSubmission = async (submission, explicitRoundId = null) => {
  const context = await resolveSubmissionRoundContext(submission, {
    explicitRoundId,
    includeHistorical: false,
    allowFallbackByYearLevel: true,
    includeFaceToFace: Boolean(explicitRoundId)
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
 * Council/Regional get one current assignment; National can have multiple judges.
 *
 * @param {Object} submission - Submission document
 * @param {Object} options - { roundId }
 */
async function assignJudgeToSubmission(submission, options = {}) {
  try {
    if (!submission) {
      return { success: false, assignment: null, error: 'Submission is required' };
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
    const actionable = await ensureSubmissionActionableForAssignment(submission, round);
    if (!actionable.actionable) {
      return {
        success: false,
        assignment: null,
        error: `Submission status "${actionable.status || submission.status}" is not eligible for assignment`
      };
    }

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

    const assignmentLevel = round.level || submission.level;
    const assignmentCouncil = assignmentLevel === 'Council' ? submission.council : null;

    const existingSubmissionAssignments = await SubmissionAssignment.find({
      roundId,
      submissionId: submission._id
    }).select('judgeId');

    if (assignmentLevel !== 'National' && existingSubmissionAssignments.length > 0) {
      return {
        success: true,
        assignment: existingSubmissionAssignments[0],
        message: 'Submission already assigned for this round'
      };
    }

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
    const assignedJudgeIdsForSubmission = new Set(
      existingSubmissionAssignments.map((assignment) => String(assignment.judgeId))
    );
    const scopedAvailableJudges = availableJudges.filter((judge) =>
      judgeMatchesAreaOfFocus(judge, submissionAreaOfFocus)
      && (assignmentLevel !== 'National' || !assignedJudgeIdsForSubmission.has(String(judge._id)))
    );

    if (scopedAvailableJudges.length === 0) {
      return {
        success: false,
        assignment: null,
        error: assignmentLevel === 'National'
          ? `No unassigned active National judges match area of focus "${submissionAreaOfFocus || 'N/A'}"`
          : `No active judges found for ${assignmentLevel} level at ${submission.region}${assignmentCouncil ? ` - ${assignmentCouncil}` : ''} with area of focus "${submissionAreaOfFocus || 'N/A'}"`
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
      assignment = await createSubmissionAssignment({
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
        submissionId: submission._id,
        ...(assignmentLevel === 'National' ? { judgeId: selectedJudge._id } : {})
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
      allowFallbackByYearLevel: true,
      includeFaceToFace: Boolean(options.roundId)
    });

    let assignment = null;
    let assignments = [];
    let resolvedRound = context.round || null;

    if (resolvedRound) {
      assignments = await SubmissionAssignment.find({
        submissionId,
        roundId: resolvedRound._id
      })
        .sort({ assignedAt: -1, createdAt: -1, _id: -1 })
        .populate('judgeId', 'name email username')
        .populate('roundId', 'year level status stage');
      assignment = assignments[0] || null;
    }

    if (!assignment && includeHistorical) {
      assignments = await SubmissionAssignment.find({ submissionId })
        .sort({ createdAt: -1 })
        .populate('judgeId', 'name email username')
        .populate('roundId', 'year level status stage');
      assignment = assignments[0] || null;
      resolvedRound = assignment?.roundId || resolvedRound;
    }

    return {
      success: true,
      assignment,
      assignments,
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
    if (!judge || !judge.assignedLevel) {
      return { success: true, assignedCount: 0, message: 'No round-scoped assignment required' };
    }

    const rounds = await CompetitionRound.find({
      level: judge.assignedLevel,
      status: 'active',
      stage: { $ne: 'face_to_face' }
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
        const existingQuery = {
          roundId: round._id,
          submissionId: submission._id
        };
        if (judge.assignedLevel === 'National') {
          existingQuery.judgeId = judge._id;
        }

        const existing = await SubmissionAssignment.findOne(existingQuery).select('_id');

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

    const roundResolution = await resolveActionableRoundForSubmission(submission, options.roundId || null);
    if (!roundResolution.round) {
      return { success: false, assignment: null, error: 'No active or ended round found for this submission level' };
    }

    const round = roundResolution.round;
    const actionable = await ensureSubmissionActionableForAssignment(submission, round, {
      allowDisqualified: true
    });
    if (!actionable.actionable) {
      return {
        success: false,
        assignment: null,
        error: `Submission status "${actionable.status || submission.status}" is not eligible for assignment`
      };
    }

    const assignmentLevel = round.level || submission.level;
    const isFaceToFaceRound = isFaceToFaceNationalRound(round);
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

    await ensureSubmissionInRoundSnapshot(submission, round);

    if (assignmentLevel === 'National' && !isFaceToFaceRound) {
      const areaSubmissions = await getNationalAreaSubmissionsForAssignment(round, submission);
      const areaSubmissionIds = areaSubmissions.map((areaSubmission) => areaSubmission._id);
      const existingAreaAssignments = areaSubmissionIds.length > 0
        ? await SubmissionAssignment.find({
            roundId: round._id,
            submissionId: { $in: areaSubmissionIds }
          }).select('judgeId')
        : [];
      const panelJudgeIds = [
        ...new Set(existingAreaAssignments.map((item) => String(item.judgeId)))
      ];
      const judgeAlreadyInPanel = panelJudgeIds.includes(String(judgeId));

      if (!judgeAlreadyInPanel && panelJudgeIds.length >= 3) {
        return {
          success: false,
          assignment: null,
          error: 'This National area of competition already has 3 assigned judges'
        };
      }

      const createdAssignments = [];
      let existingCount = 0;
      let assignment = null;

      for (const areaSubmission of areaSubmissions) {
        const nationalAssignmentQuery = {
          roundId: round._id,
          submissionId: areaSubmission._id,
          judgeId
        };
        let areaAssignment = await SubmissionAssignment.findOne(nationalAssignmentQuery);

        if (areaAssignment) {
          existingCount += 1;
        } else {
          try {
            areaAssignment = await createSubmissionAssignment({
              roundId: round._id,
              submissionId: areaSubmission._id,
              judgeId,
              level: assignmentLevel,
              region: areaSubmission.region || null,
              council: null,
              judgeNotified: false
            });
            createdAssignments.push(areaAssignment);
          } catch (error) {
            if (!isDuplicateKeyError(error)) {
              throw error;
            }
            areaAssignment = await SubmissionAssignment.findOne(nationalAssignmentQuery);
            if (!areaAssignment) {
              throw error;
            }
            existingCount += 1;
          }
        }

        if (String(areaSubmission._id) === String(submissionId)) {
          assignment = areaAssignment;
        }
      }

      if (!assignment) {
        assignment = createdAssignments[0] || await SubmissionAssignment.findOne({
          roundId: round._id,
          submissionId,
          judgeId
        });
      }

      for (const createdAssignment of createdAssignments) {
        notificationService.handleJudgeAssigned({
          userId: judgeId.toString(),
          submissionId: createdAssignment.submissionId.toString(),
          teacherName: submission.teacherName,
          subject: submission.subject,
          areaOfFocus: submission.areaOfFocus,
          level: assignmentLevel,
          region: submission.region,
          council: null
        }).catch((error) => {
          console.error('Error sending judge assignment notification:', error);
        });
      }

      return {
        success: true,
        assignment,
        assignments: createdAssignments,
        message: createdAssignments.length > 0
          ? `Judge assigned to ${createdAssignments.length} submission(s) in this National area of competition`
          : `Judge already assigned to ${existingCount} submission(s) in this National area of competition`,
        roundId: round._id.toString()
      };
    }

    if (assignmentLevel === 'National' && isFaceToFaceRound) {
      const assignmentQuery = {
        roundId: round._id,
        submissionId,
        judgeId
      };

      let assignment = await SubmissionAssignment.findOne(assignmentQuery);
      const hadExistingAssignment = Boolean(assignment);
      let message = 'Judge assigned to submission for face-to-face evaluation';

      if (!assignment) {
        try {
          assignment = await createSubmissionAssignment({
            roundId: round._id,
            submissionId,
            judgeId,
            level: assignmentLevel,
            region: submission.region || null,
            council: null,
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
          message = 'Judge already assigned to this face-to-face submission';
        }
      } else {
        message = 'Judge already assigned to this face-to-face submission';
      }

      if (!hadExistingAssignment && message !== 'Judge already assigned to this face-to-face submission') {
        notificationService.handleJudgeAssigned({
          userId: judgeId.toString(),
          submissionId: submissionId.toString(),
          teacherName: submission.teacherName,
          subject: submission.subject,
          areaOfFocus: submission.areaOfFocus,
          level: assignmentLevel,
          region: submission.region,
          council: null
        }).catch((error) => {
          console.error('Error sending judge assignment notification:', error);
        });
      }

      if (!hadExistingAssignment && !assignment.judgeNotified) {
        assignment.judgeNotified = true;
        await assignment.save();
      }

      return {
        success: true,
        assignment,
        assignments: [assignment],
        message,
        roundId: round._id.toString()
      };
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
        assignment = await createSubmissionAssignment({
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
    const submission = await Submission.findById(submissionId).select('_id year level roundId promotedFromRoundId region council status disqualified areaOfFocus');

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
    const isFaceToFaceRound = isFaceToFaceNationalRound(roundResolution.round);
    const assignmentCouncil = assignmentLevel === 'Council' ? submission.council : null;

    const actionable = await ensureSubmissionActionableForAssignment(submission, roundResolution.round, {
      allowDisqualified: true
    });
    if (!actionable.actionable) {
      return {
        success: true,
        judges: [],
        message: `Submission status "${actionable.status || submission.status}" is not eligible for assignment`
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

    const existingAssignments = assignmentLevel === 'National'
      ? await SubmissionAssignment.find({
          roundId: roundResolution.round._id,
          submissionId
        }).select('judgeId')
      : [];
    const assignedJudgeIds = new Set(existingAssignments.map((assignment) => String(assignment.judgeId)));
    let nationalAreaPanelJudgeIds = null;
    if (assignmentLevel === 'National' && !isFaceToFaceRound) {
      const areaSubmissions = await getNationalAreaSubmissionsForAssignment(roundResolution.round, submission);
      const areaSubmissionIds = areaSubmissions.map((areaSubmission) => areaSubmission._id);
      const areaAssignments = areaSubmissionIds.length > 0
        ? await SubmissionAssignment.find({
            roundId: roundResolution.round._id,
            submissionId: { $in: areaSubmissionIds }
          }).select('judgeId')
        : [];
      nationalAreaPanelJudgeIds = new Set(areaAssignments.map((assignment) => String(assignment.judgeId)));
    }

    const eligibleJudges = judges.filter((judge) =>
      judgeMatchesAreaOfFocus(judge, submission.areaOfFocus || '')
      && (assignmentLevel !== 'National' || !assignedJudgeIds.has(String(judge._id)))
      && (
        assignmentLevel !== 'National'
        || isFaceToFaceRound
        || nationalAreaPanelJudgeIds.size < 3
        || nationalAreaPanelJudgeIds.has(String(judge._id))
      )
    );

    return {
      success: true,
      judges: eligibleJudges,
      message: assignmentLevel === 'National' && isFaceToFaceRound && eligibleJudges.length === 0
        ? 'All matching National judges are already assigned to this face-to-face submission'
        : assignmentLevel === 'National' && eligibleJudges.length === 0 && assignedJudgeIds.size > 0
        ? 'All National area panel judges are already assigned to this submission'
        : assignmentLevel === 'National' && eligibleJudges.length === 0 && nationalAreaPanelJudgeIds?.size >= 3
          ? 'This National area of competition already has 3 assigned judges'
        : buildEligibleJudgeEmptyMessage({
            assignmentLevel,
            submission,
            totalScopedJudges: judges.length,
            eligibleCount: eligibleJudges.length
          }),
      debug: process.env.NODE_ENV === 'development' ? {
        assignmentLevel,
        submissionRegion: submission.region || null,
        submissionCouncil: submission.council || null,
        scopedJudges: judges.length,
        areaMatchedJudges: eligibleJudges.length
      } : undefined
    };
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
  getEligibleJudges,
  ensureSubmissionAssignmentIndexesReady
};
