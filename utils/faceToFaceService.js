const mongoose = require('mongoose');
const CompetitionRound = require('../models/CompetitionRound');
const Submission = require('../models/Submission');
const Evaluation = require('../models/Evaluation');
const SubmissionAssignment = require('../models/SubmissionAssignment');
const FaceToFaceSelection = require('../models/FaceToFaceSelection');

const FACE_TO_FACE_ROUND_STAGE = 'face_to_face';
const FACE_TO_FACE_WEIGHT_NATIONAL = 0.4;
const FACE_TO_FACE_WEIGHT_PANEL = 0.6;
const FACE_TO_FACE_DEFAULT_SELECTIONS_PER_AREA = 1;

const roundToTwo = (value) => Math.round((Number(value || 0) + Number.EPSILON) * 100) / 100;

const normalizeAreaOfFocusKey = (value) => String(value || 'Unknown')
  .trim()
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, '_')
  .replace(/^_+|_+$/g, '') || 'unknown';

const getAreaOfFocusLabel = (value) => {
  const label = String(value || '').trim();
  return label || 'Unknown';
};

const toObjectIdList = (values = []) => (
  [...new Set((values || []).map((value) => String(value || '').trim()).filter(Boolean))]
    .filter((value) => mongoose.Types.ObjectId.isValid(value))
    .map((value) => new mongoose.Types.ObjectId(value))
);

const normalizeEvaluationScore = (evaluation = {}) => {
  const numericAverage = Number(evaluation.averageScore);
  if (Number.isFinite(numericAverage) && numericAverage > 0) return numericAverage;

  const numericTotal = Number(evaluation.totalScore);
  if (Number.isFinite(numericTotal) && numericTotal > 0) return numericTotal;

  let scoreSum = 0;
  const scores = evaluation.scores;
  if (scores instanceof Map) {
    for (const score of scores.values()) {
      const numeric = Number(score);
      if (Number.isFinite(numeric)) scoreSum += numeric;
    }
  } else if (scores && typeof scores === 'object') {
    for (const score of Object.values(scores)) {
      const numeric = Number(score);
      if (Number.isFinite(numeric)) scoreSum += numeric;
    }
  }

  return scoreSum;
};

const resolveDashboardYear = (year) => {
  const parsedYear = Number(year);
  if (Number.isFinite(parsedYear) && parsedYear > 0) {
    return Math.floor(parsedYear);
  }
  return new Date().getFullYear();
};

const ensureFaceToFaceRound = async (year) => {
  const resolvedYear = resolveDashboardYear(year);
  let round = await CompetitionRound.findOne({
    year: resolvedYear,
    level: 'National',
    stage: FACE_TO_FACE_ROUND_STAGE
  }).sort({ createdAt: -1, _id: -1 });

  if (!round) {
    round = await CompetitionRound.create({
      year: resolvedYear,
      level: 'National',
      stage: FACE_TO_FACE_ROUND_STAGE,
      status: 'active',
      timingType: 'fixed_time',
      endTime: new Date(Date.UTC(resolvedYear + 10, 11, 31, 23, 59, 59, 999)),
      autoAdvance: false,
      waitForAllJudges: false,
      reminderEnabled: false,
      reminderFrequency: 'daily',
      metadata: {
        createdBySystem: true,
        purpose: 'face_to_face_evaluation'
      }
    });
  }

  if (!['active', 'ended'].includes(round.status)) {
    round.status = 'active';
    if (!round.endTime || Number.isNaN(new Date(round.endTime).getTime())) {
      round.endTime = new Date(Date.UTC(resolvedYear + 10, 11, 31, 23, 59, 59, 999));
    }
    await round.save();
  }

  return round;
};

const getDefaultAreaScopedSubmissions = async (year) => {
  const resolvedYear = resolveDashboardYear(year);
  const submissions = await Submission.find({
    year: resolvedYear,
    level: 'National',
    isDeleted: { $ne: true },
    disqualified: { $ne: true }
  })
    .select('_id areaOfFocus')
    .sort({ averageScore: -1, createdAt: 1, _id: 1 })
    .lean();

  const areaSelectionCounts = new Map();
  const defaults = [];

  for (const submission of submissions) {
    const areaKey = normalizeAreaOfFocusKey(submission.areaOfFocus);
    const current = Number(areaSelectionCounts.get(areaKey) || 0);
    if (current >= FACE_TO_FACE_DEFAULT_SELECTIONS_PER_AREA) continue;

    defaults.push(submission);
    areaSelectionCounts.set(areaKey, current + 1);
  }

  return defaults;
};

const getFaceToFaceCandidates = async (year) => {
  const resolvedYear = resolveDashboardYear(year);
  return Submission.find({
    year: resolvedYear,
    level: 'National',
    isDeleted: { $ne: true },
    disqualified: { $ne: true }
  })
    .select('_id teacherName school category class subject areaOfFocus region council status averageScore createdAt updatedAt')
    .sort({ averageScore: -1, createdAt: 1, _id: 1 })
    .lean();
};

const getManualSelectionIdsForRound = async (roundId) => {
  const docs = await FaceToFaceSelection.find({ roundId })
    .select('submissionId')
    .lean();
  return docs.map((item) => String(item.submissionId));
};

const buildSelectionIdSet = ({ candidates = [], defaultIds = [], manualIds = [] }) => {
  const candidateIdSet = new Set(candidates.map((candidate) => String(candidate._id)));
  const selectedSet = new Set();

  for (const id of defaultIds) {
    if (candidateIdSet.has(id)) selectedSet.add(id);
  }

  for (const id of manualIds) {
    if (candidateIdSet.has(id)) selectedSet.add(id);
  }

  return selectedSet;
};

const sortByWeightedScore = (a, b) => {
  if (b.finalScore !== a.finalScore) return b.finalScore - a.finalScore;
  if (b.faceToFaceAverage !== a.faceToFaceAverage) return b.faceToFaceAverage - a.faceToFaceAverage;
  if (b.nationalAverage !== a.nationalAverage) return b.nationalAverage - a.nationalAverage;
  return String(a.submissionId).localeCompare(String(b.submissionId));
};

const computeFaceToFaceScoreMaps = async ({ roundId, selectedSubmissionIds = [] }) => {
  const selectedObjectIds = toObjectIdList(selectedSubmissionIds);
  if (selectedObjectIds.length === 0) {
    return {
      assignedJudgeIdsBySubmission: new Map(),
      evaluatedJudgeIdsBySubmission: new Map(),
      faceAverageBySubmission: new Map()
    };
  }

  const assignments = await SubmissionAssignment.find({
    roundId,
    submissionId: { $in: selectedObjectIds }
  }).select('submissionId judgeId').lean();

  const assignedJudgeIdsBySubmission = new Map();
  for (const assignment of assignments) {
    const submissionId = String(assignment.submissionId);
    const judgeId = String(assignment.judgeId || '');
    if (!judgeId) continue;
    if (!assignedJudgeIdsBySubmission.has(submissionId)) {
      assignedJudgeIdsBySubmission.set(submissionId, new Set());
    }
    assignedJudgeIdsBySubmission.get(submissionId).add(judgeId);
  }

  const evaluations = await Evaluation.find({
    roundId,
    submissionId: { $in: selectedObjectIds }
  }).select('submissionId judgeId averageScore totalScore scores submittedAt updatedAt createdAt').lean();

  const latestEvaluationBySubmissionJudge = new Map();
  for (const evaluation of evaluations) {
    const submissionId = String(evaluation.submissionId);
    const judgeId = String(evaluation.judgeId || '');
    if (!judgeId) continue;
    const pairKey = `${submissionId}::${judgeId}`;
    const currentTime = new Date(
      evaluation.submittedAt || evaluation.updatedAt || evaluation.createdAt || 0
    ).getTime();
    const previous = latestEvaluationBySubmissionJudge.get(pairKey);
    const previousTime = previous
      ? new Date(previous.submittedAt || previous.updatedAt || previous.createdAt || 0).getTime()
      : -1;
    if (!previous || currentTime >= previousTime) {
      latestEvaluationBySubmissionJudge.set(pairKey, evaluation);
    }
  }

  const evaluatedJudgeIdsBySubmission = new Map();
  const faceAverageAccumulator = new Map();

  for (const [pairKey, evaluation] of latestEvaluationBySubmissionJudge.entries()) {
    const [submissionId, judgeId] = pairKey.split('::');
    if (!evaluatedJudgeIdsBySubmission.has(submissionId)) {
      evaluatedJudgeIdsBySubmission.set(submissionId, new Set());
    }
    evaluatedJudgeIdsBySubmission.get(submissionId).add(judgeId);

    const current = faceAverageAccumulator.get(submissionId) || { sum: 0, count: 0 };
    current.sum += normalizeEvaluationScore(evaluation);
    current.count += 1;
    faceAverageAccumulator.set(submissionId, current);
  }

  const faceAverageBySubmission = new Map();
  for (const [submissionId, value] of faceAverageAccumulator.entries()) {
    faceAverageBySubmission.set(
      submissionId,
      value.count > 0 ? roundToTwo(value.sum / value.count) : 0
    );
  }

  return {
    assignedJudgeIdsBySubmission,
    evaluatedJudgeIdsBySubmission,
    faceAverageBySubmission
  };
};

const buildFaceToFaceDashboard = async ({ year }) => {
  const resolvedYear = resolveDashboardYear(year);
  const round = await ensureFaceToFaceRound(resolvedYear);
  const [defaultSelectionDocs, candidates, manualSelectionIds] = await Promise.all([
    getDefaultAreaScopedSubmissions(resolvedYear),
    getFaceToFaceCandidates(resolvedYear),
    getManualSelectionIdsForRound(round._id)
  ]);

  const defaultSelectionIds = defaultSelectionDocs.map((item) => String(item._id));
  const defaultSelectionIdSet = new Set(defaultSelectionIds);
  const selectedIdSet = buildSelectionIdSet({
    candidates,
    defaultIds: defaultSelectionIds,
    manualIds: manualSelectionIds
  });
  const selectedIds = [...selectedIdSet];

  const {
    assignedJudgeIdsBySubmission,
    evaluatedJudgeIdsBySubmission,
    faceAverageBySubmission
  } = await computeFaceToFaceScoreMaps({
    roundId: round._id,
    selectedSubmissionIds: selectedIds
  });

  const candidateRows = candidates.map((candidate) => {
    const submissionId = String(candidate._id);
    const nationalAverage = roundToTwo(candidate.averageScore || 0);
    const faceToFaceAverage = roundToTwo(faceAverageBySubmission.get(submissionId) || 0);
    const finalScore = roundToTwo(
      (nationalAverage * FACE_TO_FACE_WEIGHT_NATIONAL)
      + (faceToFaceAverage * FACE_TO_FACE_WEIGHT_PANEL)
    );
    const assignedJudgeCount = (assignedJudgeIdsBySubmission.get(submissionId) || new Set()).size;
    const completedJudgeCount = (evaluatedJudgeIdsBySubmission.get(submissionId) || new Set()).size;
    const areaLabel = getAreaOfFocusLabel(candidate.areaOfFocus);
    const areaKey = normalizeAreaOfFocusKey(areaLabel);

    return {
      id: submissionId,
      submissionId,
      roundId: round._id,
      level: 'National',
      teacherName: candidate.teacherName || 'Unknown',
      school: candidate.school || 'Unknown',
      category: candidate.category || 'Unknown',
      class: candidate.class || 'Unknown',
      subject: candidate.subject || 'Unknown',
      areaOfFocus: areaLabel,
      areaKey,
      region: candidate.region || null,
      council: candidate.council || null,
      status: candidate.status || 'submitted',
      nationalAverage,
      faceToFaceAverage,
      finalScore,
      assignedJudgeCount,
      completedJudgeCount,
      pendingJudgeCount: Math.max(assignedJudgeCount - completedJudgeCount, 0),
      isDefaultSelected: defaultSelectionIdSet.has(submissionId),
      isManualSelected: manualSelectionIds.includes(submissionId),
      isSelected: selectedIdSet.has(submissionId),
      createdAt: candidate.createdAt || null,
      updatedAt: candidate.updatedAt || null
    };
  });

  const selectedRows = candidateRows
    .filter((row) => row.isSelected)
    .sort(sortByWeightedScore)
    .map((row, index) => ({
      ...row,
      rank: index + 1
    }));

  const areaGroupMap = new Map();
  for (const row of candidateRows) {
    if (!areaGroupMap.has(row.areaKey)) {
      areaGroupMap.set(row.areaKey, {
        areaKey: row.areaKey,
        areaOfFocus: row.areaOfFocus,
        candidates: []
      });
    }
    areaGroupMap.get(row.areaKey).candidates.push(row);
  }

  const areaGroups = [...areaGroupMap.values()]
    .map((group) => {
      const sortedCandidates = [...group.candidates].sort(sortByWeightedScore);
      const selectedInArea = sortedCandidates
        .filter((row) => row.isSelected)
        .map((row, index) => ({
          ...row,
          areaRank: index + 1
        }));
      const defaultInArea = sortedCandidates
        .filter((row) => row.isDefaultSelected)
        .map((row) => row.submissionId);
      return {
        areaKey: group.areaKey,
        areaOfFocus: group.areaOfFocus,
        candidateCount: sortedCandidates.length,
        selectedCount: selectedInArea.length,
        defaultSubmissionIds: defaultInArea,
        candidates: sortedCandidates,
        selectedSubmissions: selectedInArea,
        leaderboard: selectedInArea
      };
    })
    .sort((a, b) => String(a.areaOfFocus || '').localeCompare(String(b.areaOfFocus || '')));

  return {
    success: true,
    year: resolvedYear,
    round: {
      id: round._id,
      year: round.year,
      level: round.level,
      stage: round.stage || 'standard',
      status: round.status
    },
    weights: {
      national: FACE_TO_FACE_WEIGHT_NATIONAL,
      faceToFace: FACE_TO_FACE_WEIGHT_PANEL
    },
    defaults: {
      selectionsPerArea: FACE_TO_FACE_DEFAULT_SELECTIONS_PER_AREA,
      areaCount: areaGroups.length
    },
    defaultSubmissionIds: defaultSelectionIds,
    topFiveSubmissionIds: defaultSelectionIds,
    defaultSelectionByArea: areaGroups.map((group) => ({
      areaKey: group.areaKey,
      areaOfFocus: group.areaOfFocus,
      defaultSubmissionIds: group.defaultSubmissionIds
    })),
    areaGroups,
    candidateCount: candidateRows.length,
    selectedCount: selectedRows.length,
    candidates: candidateRows,
    selectedSubmissions: selectedRows,
    leaderboard: selectedRows
  };
};

const updateFaceToFaceSelection = async ({
  year,
  submissionIds = [],
  updatedBy = null
}) => {
  const resolvedYear = resolveDashboardYear(year);
  const round = await ensureFaceToFaceRound(resolvedYear);
  const [candidates, defaultSelectionDocs] = await Promise.all([
    getFaceToFaceCandidates(resolvedYear),
    getDefaultAreaScopedSubmissions(resolvedYear)
  ]);
  const candidateIdSet = new Set(candidates.map((candidate) => String(candidate._id)));
  const defaultSelectionIdSet = new Set(defaultSelectionDocs.map((item) => String(item._id)));

  const requestedIds = [...new Set((submissionIds || []).map((id) => String(id || '').trim()).filter(Boolean))];
  const invalidIds = requestedIds.filter((id) => !candidateIdSet.has(id));
  if (invalidIds.length > 0) {
    return {
      success: false,
      status: 400,
      message: 'Some selected submissions are invalid for face-to-face stage',
      invalidSubmissionIds: invalidIds
    };
  }

  const finalSelectedSet = new Set([...defaultSelectionIdSet, ...requestedIds]);
  const manualSelectedIds = [...finalSelectedSet].filter((id) => !defaultSelectionIdSet.has(id));

  const bulkOps = manualSelectedIds.map((submissionId) => ({
    updateOne: {
      filter: { roundId: round._id, submissionId },
      update: {
        $set: {
          roundId: round._id,
          year: resolvedYear,
          submissionId,
          createdBy: updatedBy || null
        }
      },
      upsert: true
    }
  }));

  if (bulkOps.length > 0) {
    await FaceToFaceSelection.bulkWrite(bulkOps, { ordered: false });
  }

  await FaceToFaceSelection.deleteMany({
    roundId: round._id,
    submissionId: { $nin: toObjectIdList(manualSelectedIds) }
  });

  await SubmissionAssignment.deleteMany({
    roundId: round._id,
    submissionId: {
      $nin: toObjectIdList([...finalSelectedSet])
    }
  });

  const dashboard = await buildFaceToFaceDashboard({ year: resolvedYear });
  return {
    success: true,
    message: 'Face-to-face selection updated successfully',
    ...dashboard
  };
};

module.exports = {
  FACE_TO_FACE_ROUND_STAGE,
  FACE_TO_FACE_WEIGHT_NATIONAL,
  FACE_TO_FACE_WEIGHT_PANEL,
  FACE_TO_FACE_DEFAULT_SELECTIONS_PER_AREA,
  resolveDashboardYear,
  ensureFaceToFaceRound,
  buildFaceToFaceDashboard,
  updateFaceToFaceSelection
};
