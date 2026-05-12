const mongoose = require('mongoose');
const CompetitionRound = require('../models/CompetitionRound');
const RoundSnapshot = require('../models/RoundSnapshot');
const RoundChunk = require('../models/RoundChunk');
const QuotaRule = require('../models/QuotaRule');
const Quota = require('../models/Quota');
const Submission = require('../models/Submission');
const Evaluation = require('../models/Evaluation');
const User = require('../models/User');
const SubmissionAssignment = require('../models/SubmissionAssignment');
const AreaLeaderboard = require('../models/AreaLeaderboard');
const PromotionRecord = require('../models/PromotionRecord');
const { getAdminScope } = require('./adminScope');
const { resolveSubmissionRoundContext, isRoundActionable } = require('./roundContext');
const {
  getCanonicalAreaOfFocusLabel,
  normalizeAreaOfFocus,
  matchesAreaOfFocus
} = require('./areaOfFocus');

const ROUND_LEVELS = ['Council', 'Regional', 'National'];
const NEXT_LEVEL = {
  Council: 'Regional',
  Regional: 'National',
  National: null
};

const hasSubmissionVideo = (submission) => {
  const videoCandidates = [
    submission.videoFileUrl,
    submission.videoLink,
    submission.preferredLink
  ];
  return videoCandidates.some((value) => typeof value === 'string' && value.trim().length > 0);
};

const isSubmissionEligibleForLeaderboard = (submission) => {
  if (hasSubmissionVideo(submission)) return true;
  const status = String(submission?.status || '').toLowerCase();
  return ['evaluated', 'promoted', 'eliminated', 'disqualified'].includes(status)
    || Number(submission?.averageScore || 0) > 0;
};

const getAreaTypeForLevel = (level) => {
  if (level === 'Council') return 'council';
  if (level === 'Regional') return 'region';
  return 'national';
};

const buildAreaId = (level, region, council) => {
  if (level === 'Council') return `${region || 'unknown'}::${council || 'unknown'}`;
  if (level === 'Regional') return region || 'unknown';
  return 'national';
};

const parseAreaId = (level, areaId) => {
  if (level === 'Council') {
    const [region, council] = String(areaId || '').split('::');
    return { region: region || null, council: council || null };
  }
  if (level === 'Regional') {
    return { region: areaId || null, council: null };
  }
  return { region: null, council: null };
};

const buildAreaQuery = (level, areaId) => {
  const { region, council } = parseAreaId(level, areaId);
  const query = {};
  if (level === 'Council') {
    query.region = region;
    query.council = council;
  } else if (level === 'Regional') {
    query.region = region;
  }
  return query;
};

const deterministicRankSort = (a, b) => {
  const aScore = typeof a.totalScore === 'number'
    ? a.totalScore
    : (typeof a.averageScore === 'number' ? a.averageScore : 0);
  const bScore = typeof b.totalScore === 'number'
    ? b.totalScore
    : (typeof b.averageScore === 'number' ? b.averageScore : 0);
  if (bScore !== aScore) return bScore - aScore;

  const aEvaluations = typeof a.totalEvaluations === 'number' ? a.totalEvaluations : 0;
  const bEvaluations = typeof b.totalEvaluations === 'number' ? b.totalEvaluations : 0;
  if (bEvaluations !== aEvaluations) return bEvaluations - aEvaluations;

  const aCreatedAt = a.tieBreakCreatedAt ? new Date(a.tieBreakCreatedAt).getTime() : Number.MAX_SAFE_INTEGER;
  const bCreatedAt = b.tieBreakCreatedAt ? new Date(b.tieBreakCreatedAt).getTime() : Number.MAX_SAFE_INTEGER;
  if (aCreatedAt !== bCreatedAt) return aCreatedAt - bCreatedAt;

  const aSubmissionId = String(a.submissionId || '');
  const bSubmissionId = String(b.submissionId || '');
  return aSubmissionId.localeCompare(bSubmissionId);
};

const rankEntriesDeterministically = (entries) => {
  const rankedEntries = [...entries].sort(deterministicRankSort);
  rankedEntries.forEach((entry, index) => {
    entry.rank = index + 1;
  });
  return rankedEntries;
};

const isTransactionUnsupportedError = (error) => {
  const message = String(error?.message || '');
  return (
    message.includes('Transaction numbers are only allowed on a replica set member or mongos') ||
    message.includes('transactions are not supported') ||
    message.includes('Transaction is not supported') ||
    message.includes('This MongoDB deployment does not support retryable writes')
  );
};

const getNextLevel = (level) => NEXT_LEVEL[level] || null;

const getRoundSnapshot = async (roundId) => {
  return RoundSnapshot.findOne({ roundId });
};

const getChunksForArea = async (roundId, areaType, areaId) => {
  if (!areaType || areaType === 'national') return [];
  const now = new Date();
  return RoundChunk.find({
    roundId,
    areaType,
    isActive: true,
    areas: areaId,
    $and: [
      {
        $or: [
          { scheduledActivationTime: null },
          { scheduledActivationTime: { $lte: now } }
        ]
      },
      {
        $or: [
          { scheduledEndTime: null },
          { scheduledEndTime: { $gt: now } }
        ]
      }
    ]
  }).select('_id name areaType areas scheduledActivationTime scheduledEndTime');
};

const getChunkActivationTime = (chunk) => {
  if (!chunk || !chunk.scheduledActivationTime) return null;
  const value = new Date(chunk.scheduledActivationTime);
  return Number.isNaN(value.getTime()) ? null : value;
};

const getChunkEndTime = (chunk) => {
  if (!chunk || !chunk.scheduledEndTime) return null;
  const value = new Date(chunk.scheduledEndTime);
  return Number.isNaN(value.getTime()) ? null : value;
};

const isChunkActiveAtTime = (chunk, now = new Date()) => {
  if (!chunk || chunk.isActive === false) return false;
  const activationTime = getChunkActivationTime(chunk);
  const endTime = getChunkEndTime(chunk);
  if (activationTime && activationTime > now) return false;
  if (endTime && endTime <= now) return false;
  return true;
};

const isChunkDueForActivation = (chunk, now = new Date()) => {
  return isChunkActiveAtTime(chunk, now);
};

const buildChunkAreaSet = (chunks = []) => {
  const set = new Set();
  for (const chunk of chunks) {
    for (const area of chunk.areas || []) {
      const normalized = String(area || '').trim();
      if (normalized) set.add(normalized);
    }
  }
  return set;
};

const ensureChunkAreasDoNotOverlap = async (roundId, areaType) => {
  if (!['council', 'region'].includes(areaType)) {
    return { valid: true };
  }

  const chunks = await RoundChunk.find({ roundId, areaType, isActive: true }).lean();
  const seen = new Map();
  for (const chunk of chunks) {
    for (const area of chunk.areas || []) {
      if (!area) continue;
      const key = String(area).trim();
      if (!key) continue;
      if (seen.has(key)) {
        return {
          valid: false,
          area: key,
          existingChunk: seen.get(key),
          conflictingChunk: chunk.name
        };
      }
      seen.set(key, chunk.name);
    }
  }
  return { valid: true };
};

const resolveQuotaForArea = async ({ round, areaId, areaType }) => {
  const level = round.level;
  const defaultResult = { quota: 0, sourceType: 'none', sourceId: null };

  const areaRule = await QuotaRule.findOne({
    roundId: round._id,
    level,
    scopeType: 'area',
    scopeId: areaId,
    isActive: true
  }).sort({ priority: -1, createdAt: -1 });
  if (areaRule) {
    return {
      quota: areaRule.quota,
      sourceType: 'area',
      sourceId: areaRule.scopeId
    };
  }

  const chunks = await getChunksForArea(round._id, areaType, areaId);
  if (chunks.length > 0) {
    const chunkIds = chunks.map((chunk) => String(chunk._id));
    const chunkRule = await QuotaRule.findOne({
      roundId: round._id,
      level,
      scopeType: 'chunk',
      scopeId: { $in: chunkIds },
      isActive: true
    }).sort({ priority: -1, createdAt: -1 });
    if (chunkRule) {
      return {
        quota: chunkRule.quota,
        sourceType: 'chunk',
        sourceId: chunkRule.scopeId
      };
    }
  }

  const levelRule = await QuotaRule.findOne({
    roundId: round._id,
    level,
    scopeType: 'level',
    scopeId: 'default',
    isActive: true
  }).sort({ priority: -1, createdAt: -1 });
  if (levelRule) {
    return {
      quota: levelRule.quota,
      sourceType: 'level',
      sourceId: levelRule.scopeId
    };
  }

  const legacyQuota = await Quota.findOne({ year: round.year, level });
  if (legacyQuota) {
    return {
      quota: legacyQuota.quota,
      sourceType: 'level',
      sourceId: 'legacy'
    };
  }

  return defaultResult;
};

const buildActivationSubmissionQuery = (round) => {
  return {
    year: round.year,
    level: round.level,
    isDeleted: { $ne: true },
    status: { $nin: ['eliminated', 'promoted'] }
  };
};

const buildLevelSubmissionQuery = (year, level) => {
  const excludedStatuses = level === 'National'
    ? ['eliminated']
    : ['eliminated', 'promoted'];
  return {
    year: Number(year),
    level,
    isDeleted: { $ne: true },
    status: { $nin: excludedStatuses }
  };
};

const getRoundsForYearLevel = async (year, level) => {
  return CompetitionRound.find({ year: Number(year), level })
    .select('_id year level status createdAt updatedAt')
    .sort({ createdAt: 1, _id: 1 });
};

const getRoundIdsForYearLevel = async (year, level) => {
  const rounds = await getRoundsForYearLevel(year, level);
  return rounds.map((round) => round._id);
};

const getAnchorRoundForYearLevel = async (year, level) => {
  const rounds = await getRoundsForYearLevel(year, level);
  return rounds.length > 0 ? rounds[0] : null;
};

const toObjectIdList = (values = []) => {
  return (values || [])
    .filter((value) => value !== null && value !== undefined)
    .map((value) => String(value))
    .filter((value) => mongoose.Types.ObjectId.isValid(value))
    .map((value) => new mongoose.Types.ObjectId(value));
};

const buildEvaluationMatchForYearLevel = ({ year, level, submissionIds = [], roundIds = [] }) => {
  const submissionObjectIds = toObjectIdList(submissionIds);

  if (submissionObjectIds.length === 0) {
    return null;
  }

  const yearLevelClause = {
    year: Number(year),
    level
  };

  const clauses = [yearLevelClause];
  const roundObjectIds = toObjectIdList(roundIds);
  if (roundObjectIds.length > 0) {
    clauses.push({
      roundId: { $in: roundObjectIds }
    });
  }

  return {
    submissionId: { $in: submissionObjectIds },
    $or: clauses
  };
};

const getLatestEvaluationJudgeSetsBySubmission = async ({
  year,
  level,
  submissionIds,
  roundIds = []
}) => {
  const match = buildEvaluationMatchForYearLevel({ year, level, submissionIds, roundIds });
  if (!match) {
    return new Map();
  }

  const grouped = await Evaluation.aggregate([
    { $match: match },
    {
      $addFields: {
        normalizedAverageScore: {
          $convert: {
            input: '$averageScore',
            to: 'double',
            onError: null,
            onNull: null
          }
        },
        normalizedTotalScore: {
          $convert: {
            input: '$totalScore',
            to: 'double',
            onError: null,
            onNull: null
          }
        },
        scoresTotal: {
          $sum: {
            $map: {
              input: { $objectToArray: { $ifNull: ['$scores', {}] } },
              as: 'scoreItem',
              in: {
                $convert: {
                  input: '$$scoreItem.v',
                  to: 'double',
                  onError: 0,
                  onNull: 0
                }
              }
            }
          }
        }
      }
    },
    {
      $addFields: {
        resolvedAverageScore: {
          $let: {
            vars: {
              averageScore: '$normalizedAverageScore',
              totalScore: '$normalizedTotalScore',
              scoresTotal: '$scoresTotal'
            },
            in: {
              $cond: [
                {
                  $and: [
                    { $ne: ['$$averageScore', null] },
                    { $gt: ['$$averageScore', 0] }
                  ]
                },
                '$$averageScore',
                {
                  $cond: [
                    {
                      $and: [
                        { $ne: ['$$totalScore', null] },
                        { $gt: ['$$totalScore', 0] }
                      ]
                    },
                    '$$totalScore',
                    '$$scoresTotal'
                  ]
                }
              ]
            }
          }
        },
        resolvedTotalScore: {
          $let: {
            vars: {
              averageScore: '$normalizedAverageScore',
              totalScore: '$normalizedTotalScore',
              scoresTotal: '$scoresTotal'
            },
            in: {
              $cond: [
                {
                  $and: [
                    { $ne: ['$$totalScore', null] },
                    { $gt: ['$$totalScore', 0] }
                  ]
                },
                '$$totalScore',
                {
                  $cond: [
                    { $gt: ['$$scoresTotal', 0] },
                    '$$scoresTotal',
                    { $ifNull: ['$$averageScore', 0] }
                  ]
                }
              ]
            }
          }
        }
      }
    },
    { $sort: { submittedAt: -1, updatedAt: -1, createdAt: -1, _id: -1 } },
    {
      $group: {
        _id: {
          submissionId: '$submissionId',
          judgeId: '$judgeId',
          roundId: '$roundId'
        },
        submissionId: { $first: '$submissionId' },
        judgeId: { $first: '$judgeId' },
        roundId: { $first: '$roundId' },
        averageScore: { $first: '$resolvedAverageScore' },
        totalScore: { $first: '$resolvedTotalScore' }
      }
    },
    {
      $group: {
        _id: '$submissionId',
        judgeIds: { $addToSet: '$judgeId' },
        roundIds: { $addToSet: '$roundId' },
        averageScore: { $avg: '$averageScore' },
        totalScore: { $avg: '$totalScore' },
        totalEvaluations: { $sum: 1 }
      }
    }
  ]);

  const map = new Map();
  for (const item of grouped) {
    map.set(String(item._id), {
      judgeIds: new Set((item.judgeIds || []).map((judgeId) => String(judgeId))),
      roundIds: new Set((item.roundIds || []).map((roundId) => String(roundId))),
      averageScore: Math.round((item.averageScore || 0) * 100) / 100,
      totalScore: Math.round((item.totalScore || 0) * 100) / 100,
      totalEvaluations: item.totalEvaluations || 0
    });
  }
  return map;
};

const approximatelyEqual = (left, right, tolerance = 0.000001) => {
  return Math.abs(Number(left || 0) - Number(right || 0)) <= tolerance;
};

const normalizeNumeric = (value, fallback = 0) => {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
};

const toPlainObject = (value) => (
  value && typeof value.toObject === 'function' ? value.toObject() : { ...value }
);

const resolveTeacherId = (submission) => {
  const teacher = submission?.teacherId;
  if (!teacher) return null;
  if (typeof teacher === 'object' && teacher._id) return teacher._id;
  return teacher;
};

const buildLeaderboardEntryFromSubmission = (submission, scoreData = null) => {
  const resolvedScoreData = scoreData || {};
  const resolvedTeacherId = resolveTeacherId(submission);
  if (!resolvedTeacherId) return null;
  const totalEvaluations = Math.max(
    0,
    Math.floor(normalizeNumeric(resolvedScoreData.totalEvaluations))
  );

  let status = totalEvaluations > 0 ? 'evaluated' : 'pending';
  if (submission?.disqualified === true || submission?.status === 'disqualified') {
    status = 'disqualified';
  } else if (submission?.status === 'eliminated') {
    status = 'eliminated';
  } else if (submission?.status === 'promoted') {
    status = 'promoted';
  }

  return {
    submissionId: submission?._id,
    teacherId: resolvedTeacherId,
    teacherName: submission?.teacherId?.name || submission?.teacherName || 'Unknown',
    teacherEmail: submission?.teacherId?.email || '',
    school: submission?.school || 'Unknown',
    region: submission?.region || null,
    council: submission?.council || null,
    category: submission?.category || 'Unknown',
    class: submission?.class || 'Unknown',
    subject: submission?.subject || 'Unknown',
    areaOfFocus: submission?.areaOfFocus || 'Unknown',
    rank: 0,
    averageScore: normalizeNumeric(resolvedScoreData.averageScore),
    totalScore: normalizeNumeric(resolvedScoreData.totalScore),
    totalEvaluations,
    status,
    tieBreakCreatedAt: submission?.createdAt || null
  };
};

const syncLeaderboardScoresFromEvaluations = async (
  leaderboard,
  roundIdsCache = new Map(),
  areaSubmissionsCache = new Map()
) => {
  if (!leaderboard) {
    return leaderboard;
  }

  const plainEntries = Array.isArray(leaderboard.entries)
    ? leaderboard.entries.map((entry) => toPlainObject(entry))
    : [];

  const areaSubmissionsKey = `${leaderboard.year}::${leaderboard.level}::${leaderboard.areaId}`;
  let areaSubmissions = areaSubmissionsCache.get(areaSubmissionsKey);
  if (!areaSubmissions) {
    areaSubmissions = await getAreaSubmissionsForLevel(
      { year: leaderboard.year, level: leaderboard.level },
      leaderboard.areaId,
      { includeEvaluatedWithoutVideo: true }
    );
    areaSubmissionsCache.set(areaSubmissionsKey, areaSubmissions);
  }
  const plainAreaSubmissions = (areaSubmissions || []).map((submission) => toPlainObject(submission));
  const submissionsById = new Map(
    plainAreaSubmissions.map((submission) => [String(submission._id), submission])
  );

  const submissionIds = [...new Set([
    ...plainEntries
      .map((entry) => entry?.submissionId)
      .filter(Boolean)
      .map((id) => String(id)),
    ...plainAreaSubmissions
      .map((submission) => submission?._id)
      .filter(Boolean)
      .map((id) => String(id))
  ])];

  if (submissionIds.length === 0) {
    return leaderboard;
  }

  const roundKey = `${leaderboard.year}::${leaderboard.level}`;
  let roundIds = roundIdsCache.get(roundKey);
  if (!roundIds) {
    roundIds = await getRoundIdsForYearLevel(leaderboard.year, leaderboard.level);
    roundIdsCache.set(roundKey, roundIds);
  }

  const evaluationMap = await getLatestEvaluationJudgeSetsBySubmission({
    year: leaderboard.year,
    level: leaderboard.level,
    submissionIds,
    roundIds
  });

  let changed = false;
  const updatedEntries = plainEntries.map((entry) => {
    const entryId = String(entry?.submissionId || '');
    if (!entryId) return entry;

    const submission = submissionsById.get(entryId);
    const scoreData = evaluationMap.get(entryId);
    const fallbackAverage = normalizeNumeric(entry.averageScore);
    const fallbackTotal = normalizeNumeric(entry.totalScore);
    const fallbackCount = Math.max(0, Math.floor(normalizeNumeric(entry.totalEvaluations)));

    const nextAverage = scoreData ? normalizeNumeric(scoreData.averageScore) : fallbackAverage;
    const nextTotal = scoreData ? normalizeNumeric(scoreData.totalScore) : fallbackTotal;
    const nextCount = scoreData ? Math.max(0, Math.floor(normalizeNumeric(scoreData.totalEvaluations))) : fallbackCount;

    let nextStatus = entry.status;
    if (!['promoted', 'eliminated', 'disqualified'].includes(nextStatus)) {
      nextStatus = nextCount > 0 ? 'evaluated' : 'pending';
    }

    if (submission?.disqualified === true || submission?.status === 'disqualified') {
      nextStatus = 'disqualified';
    } else if (submission?.status === 'eliminated') {
      nextStatus = 'eliminated';
    } else if (submission?.status === 'promoted') {
      nextStatus = 'promoted';
    }

    const nextAreaOfFocus = submission?.areaOfFocus || entry.areaOfFocus || 'Unknown';

    if (
      !approximatelyEqual(fallbackAverage, nextAverage)
      || !approximatelyEqual(fallbackTotal, nextTotal)
      || fallbackCount !== nextCount
      || String(entry.status || '') !== String(nextStatus || '')
      || String(entry.areaOfFocus || '') !== String(nextAreaOfFocus || '')
    ) {
      changed = true;
    }

    const nextEntry = {
      ...entry,
      averageScore: nextAverage,
      totalScore: nextTotal,
      totalEvaluations: nextCount,
      status: nextStatus,
      areaOfFocus: nextAreaOfFocus
    };

    if (submission) {
      const resolvedTeacherId = resolveTeacherId(submission);
      if (resolvedTeacherId) {
        nextEntry.teacherId = resolvedTeacherId;
      }
      nextEntry.teacherName = submission.teacherId?.name || submission.teacherName || nextEntry.teacherName;
      nextEntry.teacherEmail = submission.teacherId?.email || nextEntry.teacherEmail || '';
      nextEntry.school = submission.school || nextEntry.school;
      nextEntry.region = submission.region || nextEntry.region || null;
      nextEntry.council = submission.council || nextEntry.council || null;
      nextEntry.category = submission.category || nextEntry.category;
      nextEntry.class = submission.class || nextEntry.class;
      nextEntry.subject = submission.subject || nextEntry.subject;
      nextEntry.tieBreakCreatedAt = submission.createdAt || nextEntry.tieBreakCreatedAt || null;
    }

    return nextEntry;
  });

  const existingEntryIds = new Set(
    updatedEntries
      .map((entry) => entry?.submissionId)
      .filter(Boolean)
      .map((id) => String(id))
  );
  for (const submission of plainAreaSubmissions) {
    const submissionId = String(submission?._id || '');
    if (!submissionId || existingEntryIds.has(submissionId)) continue;
    const scoreData = evaluationMap.get(submissionId) || {
      averageScore: 0,
      totalScore: 0,
      totalEvaluations: 0
    };
    const builtEntry = buildLeaderboardEntryFromSubmission(submission, scoreData);
    if (!builtEntry) {
      console.warn(`Skipping leaderboard entry without teacherId for submission ${submissionId}`);
      continue;
    }
    updatedEntries.push(builtEntry);
    changed = true;
  }

  if (!changed) {
    return leaderboard;
  }

  const rankedEntries = rankEntriesDeterministically(updatedEntries);
  const sanitizedEntries = rankedEntries.filter(
    (entry) => Boolean(entry?.submissionId) && Boolean(entry?.teacherId)
  );
  if (sanitizedEntries.length !== rankedEntries.length) {
    changed = true;
  }
  const normalizedEntries = rankEntriesDeterministically(sanitizedEntries);
  leaderboard.entries = normalizedEntries;
  leaderboard.totalSubmissions = normalizedEntries.length;
  leaderboard.totalEvaluations = normalizedEntries.reduce(
    (sum, entry) => sum + normalizeNumeric(entry.totalEvaluations),
    0
  );
  leaderboard.lastUpdated = new Date();
  await leaderboard.save();

  return leaderboard;
};

const syncLeaderboardStatusesFromPromotionDecisions = async (leaderboard) => {
  if (
    !leaderboard
    || !['finalized', 'published'].includes(leaderboard.state)
    || !leaderboard.roundId
    || !Array.isArray(leaderboard.entries)
    || leaderboard.entries.length === 0
  ) {
    return leaderboard;
  }

  const submissionIds = [...new Set(
    leaderboard.entries
      .map((entry) => entry?.submissionId)
      .filter(Boolean)
      .map((id) => String(id))
  )];
  if (submissionIds.length === 0) return leaderboard;

  const [promotionRecords, submissions] = await Promise.all([
    PromotionRecord.find({
      fromRoundId: leaderboard.roundId,
      submissionId: { $in: submissionIds }
    }).select('submissionId status'),
    Submission.find({ _id: { $in: submissionIds } })
      .select('_id level status promotedFromRoundId')
  ]);

  const decisionBySubmissionId = new Map(
    promotionRecords.map((record) => [String(record.submissionId), record.status])
  );
  const submissionById = new Map(
    submissions.map((submission) => [String(submission._id), submission])
  );
  const roundId = String(leaderboard.roundId);
  let changed = false;

  const updatedEntries = leaderboard.entries.map((entry) => {
    const plainEntry = toPlainObject(entry);
    const submissionId = String(plainEntry.submissionId || '');
    let nextStatus = decisionBySubmissionId.get(submissionId) || null;

    if (!nextStatus) {
      const submission = submissionById.get(submissionId);
      const promotedFromRoundId = submission?.promotedFromRoundId
        ? String(submission.promotedFromRoundId)
        : null;
      if (promotedFromRoundId === roundId && submission?.level !== leaderboard.level) {
        nextStatus = 'promoted';
      } else if (submission?.status === 'eliminated' && submission?.level === leaderboard.level) {
        nextStatus = 'eliminated';
      }
    }

    if (!nextStatus || plainEntry.status === nextStatus) {
      return plainEntry;
    }

    changed = true;
    return {
      ...plainEntry,
      status: nextStatus
    };
  });

  if (!changed) return leaderboard;

  leaderboard.entries = updatedEntries;
  leaderboard.lastUpdated = new Date();
  await leaderboard.save();
  return leaderboard;
};

const filterSubmissionsPendingLevelEvaluation = async (round, submissions) => {
  if (!Array.isArray(submissions) || submissions.length === 0) {
    return [];
  }

  const submissionIds = submissions.map((submission) => submission._id);
  const roundIds = await getRoundIdsForYearLevel(round.year, round.level);
  const evaluationBySubmission = await getLatestEvaluationJudgeSetsBySubmission({
    year: round.year,
    level: round.level,
    submissionIds,
    roundIds
  });

  return submissions.filter((submission) => {
    const details = evaluationBySubmission.get(String(submission._id));
    // Strict pending mode: include only submissions with zero evaluations
    // for the same year + level across rounds.
    return !details || Number(details.totalEvaluations || 0) <= 0;
  });
};

const getAreaSubmissionsForLevel = async (round, areaId, options = {}) => {
  const { includeEvaluatedWithoutVideo = false } = options;
  const areaQuery = buildAreaQuery(round.level, areaId);
  const submissions = await Submission.find({
    ...buildLevelSubmissionQuery(round.year, round.level),
    ...areaQuery
  })
    .select(
      '_id teacherId teacherName school region council category class subject areaOfFocus status disqualified createdAt videoFileUrl videoLink preferredLink'
    );

  return submissions.filter((submission) => {
    if (hasSubmissionVideo(submission)) return true;
    if (!includeEvaluatedWithoutVideo) return false;
    const status = String(submission?.status || '').toLowerCase();
    return ['evaluated', 'promoted', 'eliminated', 'disqualified'].includes(status)
      || Number(submission?.averageScore || 0) > 0;
  });
};

const getSubmissionAreaDescriptor = (level, submission) => {
  const areaId = buildAreaId(level, submission.region, submission.council);
  const areaType = getAreaTypeForLevel(level);
  return {
    areaId,
    areaType,
    region: submission.region || null,
    council: submission.council || null
  };
};

const assignRoundSubmissionsToJudges = async (round, submissions) => {
  if (!['Council', 'Regional', 'National'].includes(round.level)) {
    return { assigned: 0, unassigned: 0 };
  }

  const assignableSubmissions = submissions.filter((submission) => !(
    submission.disqualified === true || submission.status === 'disqualified'
  ));

  if (assignableSubmissions.length === 0) {
    return { assigned: 0, unassigned: 0 };
  }

  const judgeQuery = {
    role: 'judge',
    status: 'active',
    isDeleted: { $ne: true },
    assignedLevel: round.level
  };
  const judges = await User.find(judgeQuery).select('_id assignedRegion assignedCouncil areasOfFocus');
  if (judges.length === 0) {
    return { assigned: 0, unassigned: submissions.length };
  }

  if (round.level === 'National') {
    const submissionIds = assignableSubmissions.map((submission) => submission._id);
    const existingAssignments = await SubmissionAssignment.find({
      roundId: round._id,
      submissionId: { $in: submissionIds }
    }).select('submissionId judgeId');

    const existingAssignmentSet = new Set(
      existingAssignments.map((assignment) => `${assignment.submissionId}:${assignment.judgeId}`)
    );
    const newAssignments = [];

    for (const submission of assignableSubmissions) {
      const submissionAreaOfFocus = normalizeAreaOfFocus(submission.areaOfFocus || '');
      for (const judge of judges) {
        const judgeAreas = Array.isArray(judge.areasOfFocus) ? judge.areasOfFocus : [];
        if (
          submissionAreaOfFocus
          && judgeAreas.length > 0
          && !judgeAreas.some((focus) => matchesAreaOfFocus(focus, submissionAreaOfFocus))
        ) {
          continue;
        }
        const key = `${submission._id}:${judge._id}`;
        if (existingAssignmentSet.has(key)) continue;
        newAssignments.push({
          roundId: round._id,
          submissionId: submission._id,
          judgeId: judge._id,
          level: round.level,
          region: submission.region || null,
          council: null,
          judgeNotified: false
        });
        existingAssignmentSet.add(key);
      }
    }

    if (newAssignments.length > 0) {
      await SubmissionAssignment.insertMany(newAssignments, { ordered: false });
    }

    return { assigned: newAssignments.length, unassigned: 0 };
  }

  const judgesByArea = new Map();
  for (const judge of judges) {
    const judgeAreaId = buildAreaId(round.level, judge.assignedRegion, judge.assignedCouncil);
    if (!judgesByArea.has(judgeAreaId)) judgesByArea.set(judgeAreaId, []);
    judgesByArea.get(judgeAreaId).push(judge);
  }

  const submissionIds = assignableSubmissions.map((submission) => submission._id);
  const existingAssignments = await SubmissionAssignment.find({
    roundId: round._id,
    submissionId: { $in: submissionIds }
  }).select('submissionId judgeId');
  const assignedSubmissionSet = new Set(existingAssignments.map((assignment) => String(assignment.submissionId)));

  const assignmentCountMap = new Map();
  for (const assignment of existingAssignments) {
    const key = String(assignment.judgeId);
    assignmentCountMap.set(key, (assignmentCountMap.get(key) || 0) + 1);
  }

  const newAssignments = [];
  let unassigned = 0;

  for (const submission of assignableSubmissions) {
    if (assignedSubmissionSet.has(String(submission._id))) {
      continue;
    }

    const areaId = buildAreaId(round.level, submission.region, submission.council);
    const areaJudges = judgesByArea.get(areaId) || [];
    if (areaJudges.length === 0) {
      unassigned += 1;
      continue;
    }

    let selectedJudge = areaJudges[0];
    let minAssignments = assignmentCountMap.get(String(selectedJudge._id)) || 0;
    for (const judge of areaJudges) {
      const judgeCount = assignmentCountMap.get(String(judge._id)) || 0;
      if (judgeCount < minAssignments) {
        minAssignments = judgeCount;
        selectedJudge = judge;
      }
    }

    newAssignments.push({
      roundId: round._id,
      submissionId: submission._id,
      judgeId: selectedJudge._id,
      level: round.level,
      region: submission.region,
      council: submission.council || null,
      judgeNotified: false
    });
    assignmentCountMap.set(String(selectedJudge._id), minAssignments + 1);
  }

  if (newAssignments.length > 0) {
    await SubmissionAssignment.insertMany(newAssignments, { ordered: false });
  }

  return { assigned: newAssignments.length, unassigned };
};

const activateRoundWithSnapshot = async (roundId, activatedBy) => {
  const round = await CompetitionRound.findById(roundId);
  if (!round) {
    return { success: false, status: 404, message: 'Competition round not found' };
  }

  if (!['draft', 'pending'].includes(round.status)) {
    return { success: false, status: 400, message: 'Round must be in draft or pending status to activate' };
  }

  const activationTime = new Date();
  const chunkAreaType = round.level === 'Council' ? 'council' : round.level === 'Regional' ? 'region' : null;
  let configuredChunks = [];
  let dueChunksAtActivation = [];
  let endedChunkIdsAtActivation = [];

  if (chunkAreaType) {
    const chunkValidation = await ensureChunkAreasDoNotOverlap(round._id, chunkAreaType);
    if (!chunkValidation.valid) {
      return {
        success: false,
        status: 400,
        message: `Chunk area overlap detected for "${chunkValidation.area}" between "${chunkValidation.existingChunk}" and "${chunkValidation.conflictingChunk}"`
      };
    }

    configuredChunks = await RoundChunk.find({
      roundId: round._id,
      areaType: chunkAreaType,
      isActive: true
    }).select('_id areas scheduledActivationTime scheduledEndTime activatedAt endedAt');

    dueChunksAtActivation = configuredChunks.filter((chunk) => isChunkDueForActivation(chunk, activationTime));
    endedChunkIdsAtActivation = configuredChunks
      .filter((chunk) => {
        const endTime = getChunkEndTime(chunk);
        return endTime && endTime <= activationTime;
      })
      .map((chunk) => chunk._id);
  }

  const query = buildActivationSubmissionQuery(round);
  const submissions = await Submission.find(query).select(
    '_id region council status disqualified year level videoFileUrl videoLink preferredLink createdAt'
  );

  const hasChunkConfiguration = configuredChunks.length > 0;
  const dueChunkAreaSet = hasChunkConfiguration ? buildChunkAreaSet(dueChunksAtActivation) : null;

  const submissionsWithVideo = submissions.filter(hasSubmissionVideo);
  const pendingAcrossLevel = await filterSubmissionsPendingLevelEvaluation(round, submissionsWithVideo);
  if (pendingAcrossLevel.length === 0) {
    return {
      success: false,
      status: 400,
      message: `No pending submissions found for ${round.level} level in ${round.year}. This level has already been finalized for the year.`
    };
  }

  let eligibleSubmissions = pendingAcrossLevel;
  if (hasChunkConfiguration) {
    eligibleSubmissions = eligibleSubmissions.filter((submission) => {
      const areaId = buildAreaId(round.level, submission.region, submission.council);
      return dueChunkAreaSet.has(areaId);
    });
  }

  if (eligibleSubmissions.length === 0 && !hasChunkConfiguration) {
    return {
      success: false,
      status: 400,
      message: `No pending submissions found for ${round.level} level in ${round.year}. This level may already be completed.`
    };
  }

  const activeAreaMap = new Map();
  for (const submission of eligibleSubmissions) {
    const descriptor = getSubmissionAreaDescriptor(round.level, submission);
    if (!activeAreaMap.has(descriptor.areaId)) {
      activeAreaMap.set(descriptor.areaId, {
        areaType: descriptor.areaType,
        areaId: descriptor.areaId,
        region: descriptor.region,
        council: descriptor.council,
        submissionCount: 0
      });
    }
    const current = activeAreaMap.get(descriptor.areaId);
    current.submissionCount += 1;
  }

  const snapshotPayload = {
    roundId: round._id,
    year: round.year,
    level: round.level,
    submissionIds: eligibleSubmissions.map((submission) => submission._id),
    activeAreas: [...activeAreaMap.values()],
    totalSubmissions: eligibleSubmissions.length,
    frozenAt: activationTime,
    metadata: {
      activatedBy: activatedBy ? String(activatedBy) : null,
      configuredChunkCount: configuredChunks.length,
      activatedChunkCount: dueChunksAtActivation.length,
      endedChunkCount: endedChunkIdsAtActivation.length
    }
  };

  const snapshot = await RoundSnapshot.findOneAndUpdate(
    { roundId: round._id },
    snapshotPayload,
    { upsert: true, new: true, runValidators: true }
  );

  await Submission.updateMany(
    { _id: { $in: snapshot.submissionIds } },
    { $set: { roundId: round._id } }
  );

  round.status = 'active';
  round.activationSnapshotId = snapshot._id;
  round.activeAreas = snapshot.activeAreas;
  round.pendingSubmissionsSnapshot = snapshot.submissionIds;
  round.snapshotCreatedAt = activationTime;
  if (!round.startTime) {
    round.startTime = activationTime;
  }
  if (round.timingType === 'countdown' && round.countdownDuration) {
    round.endTime = new Date(round.startTime.getTime() + round.countdownDuration);
  }
  await round.save();

  const assignmentResult = await assignRoundSubmissionsToJudges(round, eligibleSubmissions);
  if (dueChunksAtActivation.length > 0) {
    await RoundChunk.updateMany(
      {
        _id: { $in: dueChunksAtActivation.map((chunk) => chunk._id) },
        activatedAt: null
      },
      { $set: { activatedAt: activationTime } }
    );
  }

  if (endedChunkIdsAtActivation.length > 0) {
    await RoundChunk.updateMany(
      {
        _id: { $in: endedChunkIdsAtActivation },
        endedAt: null
      },
      { $set: { endedAt: activationTime } }
    );
  }

  return {
    success: true,
    round,
    snapshot,
    snapshotSize: snapshot.totalSubmissions,
    activeAreas: snapshot.activeAreas,
    assignments: assignmentResult,
    chunkSchedule: {
      configured: configuredChunks.length,
      activatedNow: dueChunksAtActivation.length,
      pending: Math.max(configuredChunks.length - dueChunksAtActivation.length - endedChunkIdsAtActivation.length, 0),
      endedNow: endedChunkIdsAtActivation.length
    }
  };
};

const activateDueChunksForRound = async (roundOrId, options = {}) => {
  const now = options.now ? new Date(options.now) : new Date();
  const round = (roundOrId && typeof roundOrId === 'object' && roundOrId._id)
    ? roundOrId
    : await CompetitionRound.findById(roundOrId);

  if (!round) {
    return { success: false, status: 404, message: 'Round not found' };
  }

  if (round.status !== 'active') {
    return {
      success: true,
      activatedChunks: 0,
      endedChunks: 0,
      addedSubmissions: 0,
      assignments: { assigned: 0, unassigned: 0 }
    };
  }

  const areaType = round.level === 'Council' ? 'council' : round.level === 'Regional' ? 'region' : null;
  if (!areaType) {
    return {
      success: true,
      activatedChunks: 0,
      endedChunks: 0,
      addedSubmissions: 0,
      assignments: { assigned: 0, unassigned: 0 }
    };
  }

  const endedChunks = await RoundChunk.find({
    roundId: round._id,
    areaType,
    isActive: true,
    endedAt: null,
    scheduledEndTime: { $ne: null, $lte: now }
  }).select('_id');

  if (endedChunks.length > 0) {
    await RoundChunk.updateMany(
      { _id: { $in: endedChunks.map((chunk) => chunk._id) }, endedAt: null },
      { $set: { endedAt: now } }
    );
  }

  const dueChunks = await RoundChunk.find({
    roundId: round._id,
    areaType,
    isActive: true,
    $or: [{ endedAt: null }, { endedAt: { $gt: now } }],
    activatedAt: null,
    $and: [
      {
        $or: [
          { scheduledActivationTime: null },
          { scheduledActivationTime: { $lte: now } }
        ]
      },
      {
        $or: [
          { scheduledEndTime: null },
          { scheduledEndTime: { $gt: now } }
        ]
      }
    ]
  }).select('_id areas');

  if (dueChunks.length === 0) {
    return {
      success: true,
      activatedChunks: 0,
      endedChunks: endedChunks.length,
      addedSubmissions: 0,
      assignments: { assigned: 0, unassigned: 0 }
    };
  }

  const areaSet = buildChunkAreaSet(dueChunks);
  const query = buildActivationSubmissionQuery(round);
  const candidates = await Submission.find(query).select(
    '_id region council status disqualified year level videoFileUrl videoLink preferredLink createdAt'
  );

  const snapshot = await RoundSnapshot.findOne({ roundId: round._id });
  const existingSubmissionIdSet = new Set([
    ...((round.pendingSubmissionsSnapshot || []).map((id) => String(id))),
    ...((snapshot?.submissionIds || []).map((id) => String(id)))
  ]);

  const candidateSubmissions = candidates
    .filter(hasSubmissionVideo)
    .filter((submission) => {
      const areaId = buildAreaId(round.level, submission.region, submission.council);
      return areaSet.has(areaId);
    });

  const pendingCandidateSubmissions = await filterSubmissionsPendingLevelEvaluation(
    round,
    candidateSubmissions
  );

  const dueSubmissions = pendingCandidateSubmissions
    .filter((submission) => !existingSubmissionIdSet.has(String(submission._id)));

  const dueSubmissionIds = dueSubmissions.map((submission) => submission._id);
  const mergedSubmissionIds = [
    ...existingSubmissionIdSet,
    ...dueSubmissionIds.map((id) => String(id))
  ];

  const existingAreaMap = new Map();
  const baseAreas = Array.isArray(snapshot?.activeAreas) && snapshot.activeAreas.length > 0
    ? snapshot.activeAreas
    : (round.activeAreas || []);

  for (const area of baseAreas) {
    if (!area?.areaId) continue;
    existingAreaMap.set(String(area.areaId), {
      areaType: area.areaType,
      areaId: area.areaId,
      region: area.region || null,
      council: area.council || null,
      submissionCount: Number(area.submissionCount) || 0
    });
  }

  for (const submission of dueSubmissions) {
    const descriptor = getSubmissionAreaDescriptor(round.level, submission);
    const current = existingAreaMap.get(descriptor.areaId) || {
      areaType: descriptor.areaType,
      areaId: descriptor.areaId,
      region: descriptor.region,
      council: descriptor.council,
      submissionCount: 0
    };
    current.submissionCount += 1;
    existingAreaMap.set(descriptor.areaId, current);
  }

  const snapshotPayload = {
    roundId: round._id,
    year: round.year,
    level: round.level,
    submissionIds: mergedSubmissionIds,
    activeAreas: [...existingAreaMap.values()],
    totalSubmissions: mergedSubmissionIds.length,
    frozenAt: snapshot?.frozenAt || round.snapshotCreatedAt || now,
    metadata: {
      ...(snapshot?.metadata || {}),
      lastChunkActivationAt: now,
      lastActivatedChunkIds: dueChunks.map((chunk) => String(chunk._id)),
      lastEndedChunkIds: endedChunks.map((chunk) => String(chunk._id))
    }
  };

  const updatedSnapshot = await RoundSnapshot.findOneAndUpdate(
    { roundId: round._id },
    snapshotPayload,
    { upsert: true, new: true, runValidators: true }
  );

  if (dueSubmissionIds.length > 0) {
    await Submission.updateMany(
      { _id: { $in: dueSubmissionIds } },
      { $set: { roundId: round._id } }
    );
  }

  round.pendingSubmissionsSnapshot = updatedSnapshot.submissionIds || [];
  round.activeAreas = updatedSnapshot.activeAreas || [];
  if (!round.activationSnapshotId) {
    round.activationSnapshotId = updatedSnapshot._id;
  }
  if (!round.snapshotCreatedAt) {
    round.snapshotCreatedAt = now;
  }
  await round.save();

  const assignments = await assignRoundSubmissionsToJudges(round, dueSubmissions);

  await RoundChunk.updateMany(
    { _id: { $in: dueChunks.map((chunk) => chunk._id) }, activatedAt: null },
    { $set: { activatedAt: now } }
  );

  return {
    success: true,
    activatedChunks: dueChunks.length,
    endedChunks: endedChunks.length,
    addedSubmissions: dueSubmissions.length,
    assignments
  };
};

const ensureAssignedSubmissionInRoundSnapshot = async (submission, round) => {
  if (!submission || !round || !['active', 'ended'].includes(round.status)) return false;

  const assignment = await SubmissionAssignment.findOne({
    roundId: round._id,
    submissionId: submission._id
  }).select('_id');
  if (!assignment) return false;

  const submissionId = String(submission._id);
  const snapshot = await getRoundSnapshot(round._id);
  const existingIds = new Set([
    ...((round.pendingSubmissionsSnapshot || []).map((id) => String(id))),
    ...((snapshot?.submissionIds || []).map((id) => String(id)))
  ]);
  if (existingIds.has(submissionId)) return true;

  const descriptor = getSubmissionAreaDescriptor(round.level, submission);
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
        lastEvaluationRepairAt: new Date(),
        lastEvaluationRepairSubmissionId: submission._id
      }
    },
    { upsert: true, new: true, runValidators: true }
  );

  await Submission.updateOne({ _id: submission._id }, { $set: { roundId: round._id } });
  round.pendingSubmissionsSnapshot = updatedSnapshot.submissionIds || [];
  round.activeAreas = updatedSnapshot.activeAreas || [];
  if (!round.activationSnapshotId) {
    round.activationSnapshotId = updatedSnapshot._id;
  }
  if (!round.snapshotCreatedAt) {
    round.snapshotCreatedAt = new Date();
  }
  await round.save();

  return true;
};

const getRoundBySubmissionForEvaluation = async (submission) => {
  const context = await resolveSubmissionRoundContext(submission, {
    includeHistorical: false,
    allowFallbackByYearLevel: true
  });
  const round = context.round;

  if (!round || !isRoundActionable(round)) {
    return null;
  }

  const snapshot = await getRoundSnapshot(round._id);

  const submissionId = String(submission._id);
  const inSnapshot = (snapshot?.submissionIds || []).some((id) => String(id) === submissionId);
  if (!inSnapshot) {
    const repaired = await ensureAssignedSubmissionInRoundSnapshot(submission, round);
    return repaired ? round : null;
  }

  return round;
};

const recalculateSubmissionAverageForRound = async (submissionId, roundId) => {
  const round = await CompetitionRound.findById(roundId).select('_id year level');
  if (!round) {
    return { averageScore: 0, totalEvaluations: 0 };
  }
  const submission = await Submission.findById(submissionId).select('disqualified status');
  const roundIds = await getRoundIdsForYearLevel(round.year, round.level);
  const evaluationBySubmission = await getLatestEvaluationJudgeSetsBySubmission({
    year: round.year,
    level: round.level,
    submissionIds: [submissionId],
    roundIds
  });
  const scoreData = evaluationBySubmission.get(String(submissionId)) || {
    averageScore: 0,
    totalEvaluations: 0
  };

  const isDisqualified = Boolean(
    submission && (submission.disqualified === true || submission.status === 'disqualified')
  );

  if (isDisqualified) {
    await Submission.findByIdAndUpdate(submissionId, {
      averageScore: scoreData.averageScore || 0,
      status: 'disqualified',
      disqualified: true
    });
    return {
      averageScore: scoreData.averageScore || 0,
      totalEvaluations: scoreData.totalEvaluations || 0
    };
  }

  if (!scoreData.totalEvaluations) {
    await Submission.findByIdAndUpdate(submissionId, {
      averageScore: 0,
      status: 'submitted'
    });
    return { averageScore: 0, totalEvaluations: 0 };
  }

  await Submission.findByIdAndUpdate(submissionId, {
    averageScore: scoreData.averageScore || 0,
    status: 'evaluated'
  });

  return {
    averageScore: scoreData.averageScore || 0,
    totalEvaluations: scoreData.totalEvaluations || 0
  };
};

const getAreaSubmissionIdsFromSnapshot = async (round, areaId) => {
  const snapshot = await getRoundSnapshot(round._id);
  if (!snapshot || !snapshot.submissionIds || snapshot.submissionIds.length === 0) {
    return [];
  }

  const areaQuery = buildAreaQuery(round.level, areaId);
  const submissions = await Submission.find({
    _id: { $in: snapshot.submissionIds },
    ...areaQuery
  }).select('_id');

  return submissions.map((submission) => submission._id);
};

const rebuildAreaLeaderboard = async (roundId, areaId, options = {}) => {
  const { forceUnlocked = false } = options;

  const round = await CompetitionRound.findById(roundId);
  if (!round) {
    return null;
  }

  const areaType = getAreaTypeForLevel(round.level);
  const anchorRound = await getAnchorRoundForYearLevel(round.year, round.level);
  const leaderboardRoundId = anchorRound?._id || round._id;
  let existingLeaderboard = await AreaLeaderboard.findOne({
    year: round.year,
    level: round.level,
    areaType,
    areaId
  }).sort({ updatedAt: -1, createdAt: -1, _id: -1 });

  if (!existingLeaderboard) {
    existingLeaderboard = await AreaLeaderboard.findOne({
      roundId: leaderboardRoundId,
      level: round.level,
      areaType,
      areaId
    });
  }

  if (existingLeaderboard && existingLeaderboard.isLocked && !forceUnlocked) {
    return existingLeaderboard;
  }

  const submissions = (await getAreaSubmissionsForLevel(round, areaId, { includeEvaluatedWithoutVideo: true }))
    .map((submission) => (submission && typeof submission.toObject === 'function' ? submission.toObject() : submission));
  const submissionIds = submissions.map((submission) => submission._id);
  const roundIds = await getRoundIdsForYearLevel(round.year, round.level);
  const evaluationMap = await getLatestEvaluationJudgeSetsBySubmission({
    year: round.year,
    level: round.level,
    submissionIds,
    roundIds
  });

  const entries = submissions.map((submission) => {
    const scoreData = evaluationMap.get(String(submission._id)) || {
      averageScore: 0,
      totalScore: 0,
      totalEvaluations: 0
    };
    const entry = {
      submissionId: submission._id,
      teacherId: submission.teacherId?._id || submission.teacherId,
      teacherName: submission.teacherId?.name || submission.teacherName || 'Unknown',
      teacherEmail: submission.teacherId?.email || '',
      school: submission.school || 'Unknown',
      region: submission.region || null,
      council: submission.council || null,
      category: submission.category || 'Unknown',
      class: submission.class || 'Unknown',
      subject: submission.subject || 'Unknown',
      areaOfFocus: submission.areaOfFocus || 'Unknown',
      rank: 0,
      averageScore: scoreData.averageScore,
      totalScore: scoreData.totalScore,
      totalEvaluations: scoreData.totalEvaluations,
      status: scoreData.totalEvaluations > 0 ? 'evaluated' : 'pending',
      tieBreakCreatedAt: submission.createdAt || null
    };

    if (submission.disqualified === true || submission.status === 'disqualified') {
      entry.status = 'disqualified';
    } else if (submission.status === 'eliminated') {
      entry.status = 'eliminated';
    } else if (submission.status === 'promoted') {
      entry.status = 'promoted';
    }

    return entry;
  });

  const rankedEntries = rankEntriesDeterministically(entries);
  const quotaInfo = await resolveQuotaForArea({ round, areaId, areaType });
  const chunks = await getChunksForArea(round._id, areaType, areaId);

  const preservedState = existingLeaderboard && ['finalized', 'published'].includes(existingLeaderboard.state)
    ? existingLeaderboard.state
    : existingLeaderboard && existingLeaderboard.state === 'awaiting_superadmin_approval'
      ? 'awaiting_superadmin_approval'
      : 'provisional';

  const upsertPayload = {
    year: round.year,
    level: round.level,
    roundId: leaderboardRoundId,
    areaType,
    areaId,
    region: parseAreaId(round.level, areaId).region,
    council: parseAreaId(round.level, areaId).council,
    chunkIds: chunks.map((chunk) => chunk._id),
    entries: rankedEntries,
    totalSubmissions: rankedEntries.length,
    totalEvaluations: rankedEntries.reduce((sum, entry) => sum + (entry.totalEvaluations || 0), 0),
    quota: quotaInfo.quota,
    state: preservedState,
    isLocked: existingLeaderboard ? existingLeaderboard.isLocked : false,
    lastUpdated: new Date(),
    metadata: {
      ...(existingLeaderboard?.metadata || {}),
      sourceRoundId: String(round._id),
      leaderboardRoundId: String(leaderboardRoundId),
      quotaSourceType: quotaInfo.sourceType,
      quotaSourceId: quotaInfo.sourceId
    }
  };

  return AreaLeaderboard.findOneAndUpdate(
    { year: round.year, level: round.level, areaType, areaId },
    upsertPayload,
    { upsert: true, new: true, runValidators: true }
  );
};

const checkAreaJudgeCompletion = async (roundId, areaId, options = {}) => {
  const scopedAreaOfFocus = normalizeAreaOfFocus(options?.areaOfFocus);
  const round = await CompetitionRound.findById(roundId);
  if (!round) {
    return {
      ready: false,
      pendingCount: 0,
      totalSubmissions: 0,
      totalJudges: 0,
      blockers: ['Round not found']
    };
  }

  let submissions = await getAreaSubmissionsForLevel(round, areaId);
  if (scopedAreaOfFocus) {
    submissions = submissions.filter((submission) =>
      matchesAreaOfFocus(submission?.areaOfFocus, scopedAreaOfFocus)
    );
  }
  const submissionIds = submissions.map((submission) => submission._id);
  if (submissionIds.length === 0) {
    return {
      ready: true,
      pendingCount: 0,
      totalSubmissions: 0,
      totalJudges: 0,
      blockers: []
    };
  }

  const disqualifiedSubmissionIds = new Set(
    submissions
      .filter((submission) => submission.disqualified === true || submission.status === 'disqualified')
      .map((submission) => String(submission._id))
  );
  const roundIds = await getRoundIdsForYearLevel(round.year, round.level);
  const evaluationMap = await getLatestEvaluationJudgeSetsBySubmission({
    year: round.year,
    level: round.level,
    submissionIds,
    roundIds
  });

  const blockers = [];
  let pendingCount = 0;

  if (['Council', 'Regional'].includes(round.level)) {
    const uniqueJudgeIds = new Set();

    for (const submissionId of submissionIds) {
      const submissionKey = String(submissionId);
      if (disqualifiedSubmissionIds.has(submissionKey)) {
        continue;
      }
      const details = evaluationMap.get(submissionKey);
      if (!details || details.totalEvaluations <= 0) {
        pendingCount += 1;
        continue;
      }
      for (const judgeId of details.judgeIds) {
        uniqueJudgeIds.add(judgeId);
      }
    }

    if (pendingCount > 0 && uniqueJudgeIds.size === 0) {
      blockers.push('No completed evaluations found for this area yet');
    }

    return {
      ready: pendingCount === 0,
      pendingCount,
      totalSubmissions: submissionIds.length,
      totalJudges: uniqueJudgeIds.size,
      blockers
    };
  }

  const nationalJudges = await User.find({
    role: 'judge',
    status: 'active',
    isDeleted: { $ne: true },
    assignedLevel: round.level
  }).select('_id');
  const judgeIds = nationalJudges.map((judge) => String(judge._id));

  if (judgeIds.length === 0) {
    const activeSubmissionCount = submissionIds.length - disqualifiedSubmissionIds.size;
    return {
      ready: false,
      pendingCount: Math.max(activeSubmissionCount, 0),
      totalSubmissions: submissionIds.length,
      totalJudges: 0,
      blockers: ['No active judges assigned for this level']
    };
  }

  for (const submissionId of submissionIds) {
    const submissionKey = String(submissionId);
    if (disqualifiedSubmissionIds.has(submissionKey)) {
      continue;
    }
    const details = evaluationMap.get(submissionKey);
    const evaluatedJudgeIds = details?.judgeIds || new Set();
    const allJudgesDone = judgeIds.every((judgeId) => evaluatedJudgeIds.has(judgeId));
    if (!allJudgesDone) {
      pendingCount += 1;
    }
  }

  return {
    ready: pendingCount === 0,
    pendingCount,
    totalSubmissions: submissionIds.length,
    totalJudges: judgeIds.length,
    blockers
  };
};

const updateAreaStateByCompletion = async (roundId, areaId) => {
  const round = await CompetitionRound.findById(roundId);
  if (!round) return null;

  const areaType = getAreaTypeForLevel(round.level);
  const leaderboard = await rebuildAreaLeaderboard(roundId, areaId);
  if (!leaderboard) return null;

  if (['finalized', 'published'].includes(leaderboard.state)) {
    return leaderboard;
  }

  const completion = await checkAreaJudgeCompletion(roundId, areaId);
  const state = completion.ready ? 'awaiting_superadmin_approval' : 'provisional';
  leaderboard.state = state;
  leaderboard.lastUpdated = new Date();
  await leaderboard.save();
  return leaderboard;
};

const refreshSubmissionAndAreaLeaderboard = async ({ submissionId, roundId }) => {
  const submission = await Submission.findById(submissionId);
  if (!submission) return null;

  await recalculateSubmissionAverageForRound(submissionId, roundId);
  const areaId = buildAreaId(submission.level, submission.region, submission.council);
  await rebuildAreaLeaderboard(roundId, areaId);
  await updateAreaStateByCompletion(roundId, areaId);

  return { submissionId, areaId };
};

const approveAreaLeaderboardAndPromote = async ({
  roundId,
  areaId,
  approvedBy,
  force = false,
  quotaOverride = null,
  areaOfFocus = null
}) => {
  const round = await CompetitionRound.findById(roundId);
  if (!round) {
    return { success: false, status: 404, message: 'Competition round not found' };
  }

  const areaType = getAreaTypeForLevel(round.level);
  const leaderboard = await rebuildAreaLeaderboard(roundId, areaId, { forceUnlocked: force });
  if (!leaderboard) {
    return { success: false, status: 404, message: 'Area leaderboard not found for this round' };
  }

  if (leaderboard.state === 'published') {
    return {
      success: false,
      status: 400,
      message: 'Leaderboard is already published. Reopen it first if you need to recompute results.'
    };
  }

  const scopedAreaOfFocus = normalizeAreaOfFocus(areaOfFocus);
  const completion = await checkAreaJudgeCompletion(roundId, areaId, {
    areaOfFocus: scopedAreaOfFocus
  });
  if (!completion.ready && !force) {
    return {
      success: false,
      status: 400,
      message: 'Area is not ready for finalization. Some submissions are still missing required evaluations.',
      completion
    };
  }

  const quotaInfo = await resolveQuotaForArea({ round, areaId, areaType });
  const nextLevel = getNextLevel(round.level);
  if (scopedAreaOfFocus) {
    const hasMatchingEntries = leaderboard.entries.some((entry) =>
      matchesAreaOfFocus(entry?.areaOfFocus, scopedAreaOfFocus)
    );
    if (!hasMatchingEntries) {
      return {
        success: false,
        status: 404,
        message: 'No leaderboard entries found for the selected area of focus in this location.'
      };
    }
  }

  const eligibleEntries = leaderboard.entries.filter((entry) => {
    if (!matchesAreaOfFocus(entry?.areaOfFocus, scopedAreaOfFocus)) return false;
    return !['eliminated', 'disqualified', 'promoted'].includes(entry.status);
  });
  const normalizedEligibleEntries = eligibleEntries.map((rawEntry) => (
    rawEntry && typeof rawEntry.toObject === 'function'
      ? rawEntry.toObject()
      : { ...rawEntry }
  ));

  const promotedEntries = [];
  const eliminatedEntries = [];
  const decisionByAreaOfFocus = {};
  const defaultQuota = Math.max(0, Number(quotaInfo.quota) || 0);
  const normalizedQuotaOverride = Number.isInteger(quotaOverride) && quotaOverride > 0
    ? quotaOverride
    : null;
  const appliedQuota = round.level === 'National'
    ? 1
    : (normalizedQuotaOverride ?? defaultQuota);

  const rankedEntries = rankEntriesDeterministically(normalizedEligibleEntries);
  const effectiveQuota = round.level === 'National'
    ? (rankedEntries.length > 0 ? 1 : 0)
    : Math.max(0, Math.min(appliedQuota, rankedEntries.length));

  const promotedGroup = rankedEntries.slice(0, effectiveQuota);
  const eliminatedGroup = rankedEntries.slice(effectiveQuota);
  promotedEntries.push(...promotedGroup);
  eliminatedEntries.push(...eliminatedGroup);
  const decisionKey = scopedAreaOfFocus || 'overall';
  decisionByAreaOfFocus[decisionKey] = {
    total: rankedEntries.length,
    quota: effectiveQuota,
    promoted: promotedGroup.length,
    eliminated: eliminatedGroup.length
  };

  let targetRoundId = null;
  if (nextLevel) {
    const targetRound = await CompetitionRound.findOne({
      year: round.year,
      level: nextLevel,
      status: { $in: ['draft', 'pending', 'active', 'ended'] }
    })
      .sort({ createdAt: -1 })
      .select('_id');
    targetRoundId = targetRound?._id || null;
  }

  const promotedIds = [...new Set(promotedEntries.map((entry) => String(entry.submissionId)))];
  const eliminatedIds = [...new Set(eliminatedEntries.map((entry) => String(entry.submissionId)))];

  let result = null;
  const runFinalizationWrites = async (session = null) => {
    const writeOptions = session ? { session } : {};

      if (promotedIds.length > 0) {
        if (nextLevel) {
          await Submission.updateMany(
            { _id: { $in: promotedIds } },
            {
              $set: {
                level: nextLevel,
                status: 'submitted',
                roundId: null,
                promotedFromRoundId: round._id
              }
            },
            writeOptions
          );
        } else {
          await Submission.updateMany(
            { _id: { $in: promotedIds } },
            {
              $set: {
                status: 'promoted',
                promotedFromRoundId: round._id
              }
            },
            writeOptions
          );
        }
      }

      if (eliminatedIds.length > 0) {
        await Submission.updateMany(
          { _id: { $in: eliminatedIds } },
          {
            $set: {
              status: 'eliminated'
            }
          },
          writeOptions
        );
      }

      const areaLocation = parseAreaId(round.level, areaId);
      const records = [];
      for (const entry of promotedEntries) {
        records.push({
          fromRoundId: round._id,
          toRoundId: targetRoundId,
          submissionId: entry.submissionId,
          teacherId: entry.teacherId,
          fromLevel: round.level,
          toLevel: nextLevel,
          fromAreaType: areaType,
          fromAreaId: areaId,
          toAreaType: nextLevel === 'Regional' ? 'region' : nextLevel === 'National' ? 'national' : null,
          toAreaId: nextLevel === 'Regional' ? (entry.region || areaLocation.region) : nextLevel === 'National' ? 'national' : null,
          status: 'promoted',
          rankAtDecision: entry.rank,
          scoreAtDecision: (typeof entry.totalScore === 'number' ? entry.totalScore : entry.averageScore),
          quotaScopeType: quotaInfo.sourceType,
          quotaScopeId: quotaInfo.sourceId,
          approvedBy
        });
      }

      for (const entry of eliminatedEntries) {
        records.push({
          fromRoundId: round._id,
          toRoundId: null,
          submissionId: entry.submissionId,
          teacherId: entry.teacherId,
          fromLevel: round.level,
          toLevel: nextLevel,
          fromAreaType: areaType,
          fromAreaId: areaId,
          toAreaType: null,
          toAreaId: null,
          status: 'eliminated',
          rankAtDecision: entry.rank,
          scoreAtDecision: (typeof entry.totalScore === 'number' ? entry.totalScore : entry.averageScore),
          quotaScopeType: quotaInfo.sourceType,
          quotaScopeId: quotaInfo.sourceId,
          approvedBy
        });
      }

      if (records.length > 0) {
        await PromotionRecord.bulkWrite(
          records.map((record) => ({
            updateOne: {
              filter: {
                fromRoundId: record.fromRoundId,
                submissionId: record.submissionId
              },
              update: { $set: record },
              upsert: true
            }
          })),
          writeOptions
        );
      }

      const updatedEntries = leaderboard.entries.map((entry) => {
        const id = String(entry.submissionId);
        const promoted = promotedEntries.some((candidate) => String(candidate.submissionId) === id);
        const eliminated = eliminatedEntries.some((candidate) => String(candidate.submissionId) === id);
        const plainEntry = entry && typeof entry.toObject === 'function'
          ? entry.toObject()
          : { ...entry };
        if (promoted) return { ...plainEntry, status: 'promoted' };
        if (eliminated) return { ...plainEntry, status: 'eliminated' };
        return plainEntry;
      });

      leaderboard.entries = updatedEntries;
      leaderboard.quota = round.level === 'National' ? 1 : appliedQuota;
      leaderboard.state = 'finalized';
      leaderboard.isLocked = true;
      leaderboard.finalizedAt = new Date();
      leaderboard.finalizedBy = approvedBy;
      leaderboard.lastUpdated = new Date();
      leaderboard.metadata = {
        ...(leaderboard.metadata || {}),
        quotaSourceType: quotaInfo.sourceType,
        quotaSourceId: quotaInfo.sourceId,
        quotaOverride: normalizedQuotaOverride,
        finalizedAreaOfFocus: scopedAreaOfFocus
      };
      await leaderboard.save(writeOptions);

      result = {
        success: true,
        leaderboard,
        appliedQuota: round.level === 'National' ? 1 : appliedQuota,
        promoted: promotedEntries.length,
        eliminated: eliminatedEntries.length,
        promotedIds,
        eliminatedIds,
        decisionsByAreaOfFocus: decisionByAreaOfFocus,
        nextLevel
      };
  };

  const session = await mongoose.startSession();
  try {
    try {
      await session.withTransaction(async () => {
        await runFinalizationWrites(session);
      });
    } catch (error) {
      if (!isTransactionUnsupportedError(error)) {
        throw error;
      }

      console.warn(
        'MongoDB transactions are unavailable; finalizing leaderboard without a transaction.',
        error.message
      );
      await runFinalizationWrites();
    }
  } catch (error) {
    return {
      success: false,
      status: 500,
      message: error.message || 'Failed to finalize and promote area leaderboard'
    };
  } finally {
    await session.endSession();
  }

  return result;
};

const publishAreaLeaderboard = async ({ roundId, areaId, publishedBy, audiences = [] }) => {
  const round = await CompetitionRound.findById(roundId);
  if (!round) {
    return { success: false, status: 404, message: 'Competition round not found' };
  }

  const areaType = getAreaTypeForLevel(round.level);
  const leaderboard = await AreaLeaderboard.findOne({
    year: round.year,
    level: round.level,
    areaType,
    areaId
  }).sort({ updatedAt: -1, createdAt: -1, _id: -1 });

  if (!leaderboard) {
    return { success: false, status: 404, message: 'Area leaderboard not found' };
  }

  if (!['finalized', 'published'].includes(leaderboard.state)) {
    return {
      success: false,
      status: 400,
      message: 'Only finalized leaderboards can be published'
    };
  }

  const sanitizedAudiences = [...new Set((audiences || []).filter((audience) => ['judges', 'teachers'].includes(audience)))];
  if (sanitizedAudiences.length === 0) {
    sanitizedAudiences.push('judges', 'teachers');
  }
  leaderboard.state = 'published';
  leaderboard.publishedAt = new Date();
  leaderboard.publishedBy = publishedBy;
  leaderboard.publishedAudiences = sanitizedAudiences;
  leaderboard.publishedVersion = (leaderboard.publishedVersion || 0) + 1;
  leaderboard.isLocked = true;
  leaderboard.lastUpdated = new Date();
  await leaderboard.save();

  return { success: true, leaderboard };
};

const reopenAreaLeaderboard = async ({ roundId, areaId }) => {
  const round = await CompetitionRound.findById(roundId);
  if (!round) {
    return { success: false, status: 404, message: 'Competition round not found' };
  }

  const areaType = getAreaTypeForLevel(round.level);
  const leaderboard = await AreaLeaderboard.findOne({
    year: round.year,
    level: round.level,
    areaType,
    areaId
  }).sort({ updatedAt: -1, createdAt: -1, _id: -1 });

  if (!leaderboard) {
    return { success: false, status: 404, message: 'Area leaderboard not found' };
  }

  leaderboard.state = 'provisional';
  leaderboard.isLocked = false;
  leaderboard.finalizedAt = null;
  leaderboard.finalizedBy = null;
  leaderboard.publishedAt = null;
  leaderboard.publishedBy = null;
  leaderboard.publishedAudiences = [];
  leaderboard.lastUpdated = new Date();
  await leaderboard.save();

  return { success: true, leaderboard };
};

const getAreaReadiness = async ({ roundId, areaId }) => {
  const round = await CompetitionRound.findById(roundId);
  if (!round) {
    return { success: false, status: 404, message: 'Competition round not found' };
  }

  const leaderboard = await rebuildAreaLeaderboard(roundId, areaId);
  if (!leaderboard) {
    return { success: false, status: 404, message: 'Area leaderboard not found' };
  }

  const completion = await checkAreaJudgeCompletion(roundId, areaId);
  const updated = await updateAreaStateByCompletion(roundId, areaId);
  return {
    success: true,
    leaderboard: updated || leaderboard,
    readiness: completion
  };
};

const canAdminAccessLeaderboard = (adminUser, leaderboard) => {
  const scope = getAdminScope(adminUser);
  if (!scope || scope.level === 'None') return false;
  if (scope.level === 'National') return true;
  if (scope.level === 'Regional') {
    return leaderboard.level === 'Regional' && leaderboard.areaId === scope.region;
  }
  if (scope.level === 'Council') {
    const expected = buildAreaId('Council', scope.region, scope.council);
    return leaderboard.level === 'Council' && leaderboard.areaId === expected;
  }
  return false;
};

const listAreaLeaderboards = async ({ filters = {}, user }) => {
  const query = {};

  if (filters.roundId) {
    const round = await CompetitionRound.findById(filters.roundId).select('year level');
    if (round) {
      query.year = round.year;
      query.level = round.level;
    } else {
      query.roundId = filters.roundId;
    }
  }
  if (filters.year) query.year = parseInt(filters.year, 10);
  if (filters.level) query.level = filters.level;
  if (filters.areaType) query.areaType = filters.areaType;
  if (filters.areaId) query.areaId = filters.areaId;
  if (filters.state) query.state = filters.state;

  if (filters.chunkId) {
    query.chunkIds = new mongoose.Types.ObjectId(filters.chunkId);
  }

  if (user.role === 'admin' || user.role === 'judge' || user.role === 'teacher' || user.role === 'stakeholder') {
    query.state = { $in: ['finalized', 'published'] };
  }

  if (user.role === 'admin') {
    const scope = getAdminScope(user);
    if (!scope || scope.level === 'None') {
      query._id = { $in: [] };
    } else if (scope.level === 'Council' && scope.region && scope.council) {
      query.level = 'Council';
      query.areaType = 'council';
      query.areaId = buildAreaId('Council', scope.region, scope.council);
    } else if (scope.level === 'Regional' && scope.region) {
      query.level = 'Regional';
      query.areaType = 'region';
      query.areaId = scope.region;
    }
  }

  if (user.role === 'judge') {
    if (user.assignedLevel) query.level = user.assignedLevel;
    if (user.assignedLevel === 'Council' && user.assignedRegion && user.assignedCouncil) {
      query.areaType = 'council';
      query.areaId = buildAreaId('Council', user.assignedRegion, user.assignedCouncil);
    } else if (user.assignedLevel === 'Regional' && user.assignedRegion) {
      query.areaType = 'region';
      query.areaId = user.assignedRegion;
    } else if (user.assignedLevel === 'National') {
      query.areaType = 'national';
      query.areaId = 'national';
    }
  }

  let leaderboards = await AreaLeaderboard.find(query).sort({
    year: -1,
    level: 1,
    areaType: 1,
    areaId: 1
  });

  if (user.role === 'superadmin' && Number.isFinite(Number(query.year)) && typeof query.level === 'string') {
    const anchorRound = await getAnchorRoundForYearLevel(query.year, query.level);
    if (anchorRound) {
      const areaSubmissionQuery = {
        ...buildLevelSubmissionQuery(query.year, query.level)
      };
      if (query.areaId) {
        Object.assign(areaSubmissionQuery, buildAreaQuery(query.level, query.areaId));
      }

      const scopedSubmissions = await Submission.find(areaSubmissionQuery)
        .select('_id region council status averageScore videoFileUrl videoLink preferredLink');

      const discoveredAreaIds = new Set();
      for (const submission of scopedSubmissions) {
        if (!isSubmissionEligibleForLeaderboard(submission)) continue;
        discoveredAreaIds.add(buildAreaId(query.level, submission.region, submission.council));
      }

      const existingAreaIds = new Set(
        leaderboards.map((leaderboard) => String(leaderboard.areaId || ''))
      );
      const missingAreaIds = [...discoveredAreaIds].filter((areaId) => !existingAreaIds.has(areaId));

      if (missingAreaIds.length > 0) {
        for (const missingAreaId of missingAreaIds) {
          try {
            const rebuilt = await rebuildAreaLeaderboard(anchorRound._id, missingAreaId, { forceUnlocked: true });
            if (rebuilt) leaderboards.push(rebuilt);
          } catch (error) {
            console.warn(
              `Failed to auto-build leaderboard for area "${missingAreaId}" (${query.year}/${query.level}):`,
              error.message
            );
          }
        }
      }
    }
  }

  const roundIdsCache = new Map();
  const areaSubmissionsCache = new Map();
  const refreshedLeaderboards = [];
  for (const leaderboard of leaderboards) {
    try {
      const synced = await syncLeaderboardScoresFromEvaluations(
        leaderboard,
        roundIdsCache,
        areaSubmissionsCache
      );
      const statusSynced = await syncLeaderboardStatusesFromPromotionDecisions(synced || leaderboard);
      refreshedLeaderboards.push(statusSynced || synced || leaderboard);
    } catch (error) {
      console.warn(
        `Failed to sync leaderboard "${leaderboard?._id}" (${leaderboard?.year}/${leaderboard?.level}/${leaderboard?.areaId}):`,
        error.message
      );
      refreshedLeaderboards.push(leaderboard);
    }
  }
  leaderboards = refreshedLeaderboards;

  const statePriority = {
    published: 4,
    finalized: 3,
    awaiting_superadmin_approval: 2,
    provisional: 1
  };
  const dedupedByScope = new Map();
  for (const leaderboard of leaderboards) {
    const key = `${leaderboard.year}::${leaderboard.level}::${leaderboard.areaType}::${leaderboard.areaId}`;
    const current = dedupedByScope.get(key);
    if (!current) {
      dedupedByScope.set(key, leaderboard);
      continue;
    }

    const currentPriority = statePriority[current.state] || 0;
    const nextPriority = statePriority[leaderboard.state] || 0;
    if (nextPriority > currentPriority) {
      dedupedByScope.set(key, leaderboard);
      continue;
    }
    if (nextPriority < currentPriority) {
      continue;
    }

    const currentUpdated = new Date(current.updatedAt || current.lastUpdated || current.createdAt || 0).getTime();
    const nextUpdated = new Date(leaderboard.updatedAt || leaderboard.lastUpdated || leaderboard.createdAt || 0).getTime();
    if (nextUpdated >= currentUpdated) {
      dedupedByScope.set(key, leaderboard);
    }
  }
  leaderboards = [...dedupedByScope.values()].sort((left, right) => {
    if (left.year !== right.year) return right.year - left.year;
    if ((left.level || '') !== (right.level || '')) {
      return String(left.level || '').localeCompare(String(right.level || ''));
    }
    if ((left.areaType || '') !== (right.areaType || '')) {
      return String(left.areaType || '').localeCompare(String(right.areaType || ''));
    }
    return String(left.areaId || '').localeCompare(String(right.areaId || ''));
  });

  const requestedAreaOfFocus = normalizeAreaOfFocus(filters.areaOfFocus);
  if (requestedAreaOfFocus) {
    leaderboards = leaderboards
      .map((leaderboard) => {
        const filteredEntries = leaderboard.entries.filter(
          (entry) => matchesAreaOfFocus(entry?.areaOfFocus, requestedAreaOfFocus)
        );
        leaderboard.entries = rankEntriesDeterministically(
          filteredEntries.map((entry) => toPlainObject(entry))
        );
        leaderboard.totalSubmissions = leaderboard.entries.length;
        leaderboard.totalEvaluations = leaderboard.entries.reduce(
          (sum, entry) => sum + (entry.totalEvaluations || 0),
          0
        );
        return leaderboard;
      })
      .filter((leaderboard) => leaderboard.entries.length > 0);
  }

  if (user.role === 'teacher') {
    leaderboards = leaderboards.filter((leaderboard) =>
      Array.isArray(leaderboard.entries)
      && leaderboard.entries.some((entry) => String(entry?.teacherId) === String(user._id))
    );
  }

  return leaderboards;
};

const listCouncilAreaLeaderboards = async ({ filters = {}, user }) => {
  const normalizedFilters = {
    ...filters,
    level: 'Council',
    areaType: 'council'
  };

  if (filters.region && filters.council && !filters.areaId) {
    normalizedFilters.areaId = buildAreaId('Council', filters.region, filters.council);
  }

  const areaLeaderboards = await listAreaLeaderboards({
    filters: normalizedFilters,
    user
  });
  const scopedAreaLeaderboards = areaLeaderboards.filter((leaderboard) => {
    if (filters.region && leaderboard.region !== filters.region) return false;
    if (filters.council && leaderboard.council !== filters.council) return false;
    return true;
  });

  const groupedLeaderboards = [];
  const regionSet = new Set();
  const councilKeySet = new Set();
  const competitionAreaSet = new Set();
  const requestedAreaOfFocus = normalizeAreaOfFocus(filters.areaOfFocus);

  for (const leaderboard of scopedAreaLeaderboards) {
    const plainLeaderboard = leaderboard.toObject ? leaderboard.toObject() : leaderboard;
    const baseEntries = Array.isArray(plainLeaderboard.entries) ? plainLeaderboard.entries : [];

    if (plainLeaderboard.region) regionSet.add(plainLeaderboard.region);
    if (plainLeaderboard.region && plainLeaderboard.council) {
      councilKeySet.add(`${plainLeaderboard.region}::${plainLeaderboard.council}`);
    }

    const areaMap = new Map();
    for (const entry of baseEntries) {
      const competitionArea = getCanonicalAreaOfFocusLabel(entry.areaOfFocus);
      if (!competitionArea) continue;
      const competitionAreaKey = normalizeAreaOfFocus(competitionArea);
      if (!competitionAreaKey) continue;
      competitionAreaSet.add(competitionArea);
      if (!areaMap.has(competitionAreaKey)) {
        areaMap.set(competitionAreaKey, {
          label: competitionArea,
          entries: []
        });
      }
      areaMap.get(competitionAreaKey).entries.push(entry);
    }

    for (const [competitionAreaKey, group] of areaMap.entries()) {
      if (requestedAreaOfFocus && competitionAreaKey !== requestedAreaOfFocus) continue;
      const competitionArea = group.label;
      const entries = group.entries;

      const rankedEntries = rankEntriesDeterministically(
        entries.map((entry) => (entry && typeof entry.toObject === 'function' ? entry.toObject() : { ...entry }))
      );

      groupedLeaderboards.push({
        id: `${plainLeaderboard._id.toString()}::${competitionArea}`,
        sourceLeaderboardId: plainLeaderboard._id.toString(),
        roundId: plainLeaderboard.roundId?.toString?.() || String(plainLeaderboard.roundId),
        year: plainLeaderboard.year,
        level: plainLeaderboard.level,
        areaType: plainLeaderboard.areaType,
        areaId: plainLeaderboard.areaId,
        region: plainLeaderboard.region || null,
        council: plainLeaderboard.council || null,
        competitionArea,
        state: plainLeaderboard.state,
        isFinalized: ['finalized', 'published'].includes(plainLeaderboard.state),
        quota: plainLeaderboard.quota || 0,
        totalSubmissions: rankedEntries.length,
        totalEvaluations: rankedEntries.reduce((sum, entry) => sum + (entry.totalEvaluations || 0), 0),
        entries: rankedEntries,
        lastUpdated: plainLeaderboard.lastUpdated || plainLeaderboard.updatedAt || null
      });
    }
  }

  groupedLeaderboards.sort((left, right) => {
    if ((left.region || '') !== (right.region || '')) {
      return (left.region || '').localeCompare(right.region || '');
    }
    if ((left.council || '') !== (right.council || '')) {
      return (left.council || '').localeCompare(right.council || '');
    }
    return (left.competitionArea || '').localeCompare(right.competitionArea || '');
  });

  return {
    leaderboards: groupedLeaderboards,
    filters: {
      regions: [...regionSet].sort((a, b) => a.localeCompare(b)),
      councils: [...councilKeySet]
        .map((value) => {
          const [region, council] = String(value || '').split('::');
          return {
            value,
            region: region || null,
            council: council || null
          };
        })
        .sort((a, b) => {
          if ((a.region || '') !== (b.region || '')) {
            return (a.region || '').localeCompare(b.region || '');
          }
          return (a.council || '').localeCompare(b.council || '');
        }),
      competitionAreas: [...competitionAreaSet].sort((a, b) => a.localeCompare(b))
    }
  };
};

const listAvailableLocations = async ({ year, level, areaOfFocus, user }) => {
  const filters = {
    year,
    level
  };
  const leaderboards = await listAreaLeaderboards({ filters, user });

  const locationSet = new Set();
  const normalizedAreaOfFocus = normalizeAreaOfFocus(areaOfFocus);
  for (const leaderboard of leaderboards) {
    if (normalizedAreaOfFocus) {
      const hasArea = leaderboard.entries.some((entry) =>
        matchesAreaOfFocus(entry?.areaOfFocus, normalizedAreaOfFocus)
      );
      if (!hasArea) continue;
    }
    locationSet.add(leaderboard.areaId);
  }
  return [...locationSet];
};

const findAreaLeaderboardById = async ({ id, user }) => {
  let leaderboard = await AreaLeaderboard.findById(id);
  if (!leaderboard) return null;
  leaderboard = await syncLeaderboardStatusesFromPromotionDecisions(leaderboard);

  if (
    ['judge', 'teacher', 'stakeholder', 'admin'].includes(user.role) &&
    !['finalized', 'published'].includes(leaderboard.state)
  ) {
    return null;
  }
  if (user.role === 'admin' && !canAdminAccessLeaderboard(user, leaderboard)) {
    return null;
  }
  if (user.role === 'judge') {
    if (user.assignedLevel && leaderboard.level !== user.assignedLevel) {
      return null;
    }
    if (user.assignedLevel === 'Council') {
      const expectedAreaId = buildAreaId('Council', user.assignedRegion, user.assignedCouncil);
      if (leaderboard.areaId !== expectedAreaId) return null;
    } else if (user.assignedLevel === 'Regional') {
      if (leaderboard.areaId !== user.assignedRegion) return null;
    } else if (user.assignedLevel === 'National') {
      if (leaderboard.areaId !== 'national') return null;
    }
  }
  if (user.role === 'teacher') {
    const hasTeacherEntry = leaderboard.entries.some(
      (entry) => String(entry.teacherId) === String(user._id)
    );
    if (!hasTeacherEntry) return null;
  }

  return leaderboard;
};

const getAreaIdFromSubmission = (submission) => {
  return buildAreaId(submission.level, submission.region, submission.council);
};

const markRoundEndedIfComplete = async (roundId) => {
  const round = await CompetitionRound.findById(roundId);
  if (!round) return null;

  const snapshot = await getRoundSnapshot(roundId);
  if (!snapshot || !snapshot.activeAreas) return round;

  const readinessResults = await Promise.all(
    snapshot.activeAreas.map((area) => checkAreaJudgeCompletion(roundId, area.areaId))
  );
  const allReady = readinessResults.every((result) => result.ready);

  if (allReady && round.status === 'active') {
    round.status = 'ended';
    round.endedAt = new Date();
    await round.save();
  }

  return round;
};

const addSubmissionToActiveRoundSnapshot = async (round, submission) => {
  if (!round || !submission) {
    return { success: false, status: 400, message: 'Round and submission are required' };
  }

  if (round.status !== 'active') {
    return { success: false, status: 400, message: 'Round is not active' };
  }

  const submissionId = String(submission._id);
  const snapshot = await RoundSnapshot.findOne({ roundId: round._id });
  const existingIds = new Set([
    ...((round.pendingSubmissionsSnapshot || []).map((id) => String(id))),
    ...((snapshot?.submissionIds || []).map((id) => String(id)))
  ]);

  if (existingIds.has(submissionId)) {
    return { success: true, alreadyExists: true, assignments: { assigned: 0, unassigned: 0 } };
  }

  const descriptor = getSubmissionAreaDescriptor(round.level, submission);
  const baseAreas = Array.isArray(snapshot?.activeAreas) && snapshot.activeAreas.length > 0
    ? snapshot.activeAreas
    : (round.activeAreas || []);
  const areaMap = new Map();
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
  const snapshotPayload = {
    roundId: round._id,
    year: round.year,
    level: round.level,
    submissionIds: updatedIds,
    activeAreas: [...areaMap.values()],
    totalSubmissions: updatedIds.length,
    frozenAt: snapshot?.frozenAt || round.snapshotCreatedAt || new Date(),
    metadata: {
      ...(snapshot?.metadata || {}),
      lastManualAdditionAt: new Date(),
      lastManualSubmissionId: submission._id
    }
  };

  const updatedSnapshot = await RoundSnapshot.findOneAndUpdate(
    { roundId: round._id },
    snapshotPayload,
    { upsert: true, new: true, runValidators: true }
  );

  await Submission.updateOne(
    { _id: submission._id },
    { $set: { roundId: round._id } }
  );

  round.pendingSubmissionsSnapshot = updatedSnapshot.submissionIds || [];
  round.activeAreas = updatedSnapshot.activeAreas || [];
  if (!round.activationSnapshotId) {
    round.activationSnapshotId = updatedSnapshot._id;
  }
  if (!round.snapshotCreatedAt) {
    round.snapshotCreatedAt = new Date();
  }
  await round.save();

  const assignments = await assignRoundSubmissionsToJudges(round, [submission]);
  return {
    success: true,
    snapshot: updatedSnapshot,
    assignments
  };
};

/**
 * Discover areas that have eligible submissions but no AreaLeaderboard document
 * (or one with 0 entries). Used by the superadmin "Build Leaderboard" feature.
 */
const discoverMissingLeaderboardAreas = async ({ year, level, region, council, areaOfFocus }) => {
  const baseQuery = {
    year: Number(year),
    level,
    isDeleted: { $ne: true },
    status: { $nin: level === 'National' ? ['eliminated'] : ['eliminated', 'promoted'] }
  };
  if (region) baseQuery.region = region;
  if (council) baseQuery.council = council;

  const submissions = await Submission.find(baseQuery)
    .select('_id region council areaOfFocus status averageScore videoFileUrl videoLink preferredLink teacherName school category class subject')
    .populate('teacherId', 'name email');

  // Group submissions by areaId
  const areaMap = new Map();
  for (const sub of submissions) {
    // A submission is eligible if it has video, is evaluated, or has a score
    if (!isSubmissionEligibleForLeaderboard(sub)) continue;

    const areaId = buildAreaId(level, sub.region, sub.council);
    if (!areaMap.has(areaId)) {
      areaMap.set(areaId, {
        areaId,
        areaType: getAreaTypeForLevel(level),
        region: sub.region || null,
        council: sub.council || null,
        submissions: [],
        areasOfFocus: new Set()
      });
    }
    const area = areaMap.get(areaId);
    area.submissions.push(sub);
    const canonicalAreaOfFocus = getCanonicalAreaOfFocusLabel(sub.areaOfFocus);
    if (canonicalAreaOfFocus) area.areasOfFocus.add(canonicalAreaOfFocus);
  }

  // Get existing leaderboards for this scope
  const existingLeaderboards = await AreaLeaderboard.find({
    year: Number(year),
    level
  }).select('areaId entries');

  const existingWithEntries = new Set();
  for (const lb of existingLeaderboards) {
    if (Array.isArray(lb.entries) && lb.entries.length > 0) {
      existingWithEntries.add(lb.areaId);
    }
  }

  // Find areas that have submissions but no leaderboard with entries
  const normalizedAoF = normalizeAreaOfFocus(areaOfFocus);
  const missingAreas = [];

  for (const [areaId, areaData] of areaMap.entries()) {
    if (existingWithEntries.has(areaId)) continue;
    if (areaData.submissions.length === 0) continue;

    let filteredSubs = areaData.submissions;
    if (normalizedAoF) {
      filteredSubs = filteredSubs.filter((s) =>
        matchesAreaOfFocus(s.areaOfFocus, normalizedAoF)
      );
    }
    if (filteredSubs.length === 0) continue;

    missingAreas.push({
      areaId,
      areaType: areaData.areaType,
      region: areaData.region,
      council: areaData.council,
      eligibleCount: filteredSubs.length,
      evaluatedCount: filteredSubs.filter(
        (s) => s.status === 'evaluated' || Number(s.averageScore || 0) > 0
      ).length,
      areasOfFocus: [...areaData.areasOfFocus].sort()
    });
  }

  return missingAreas.sort((a, b) => a.areaId.localeCompare(b.areaId));
};

module.exports = {
  ROUND_LEVELS,
  getNextLevel,
  getAreaTypeForLevel,
  buildAreaId,
  parseAreaId,
  deterministicRankSort,
  rankEntriesDeterministically,
  ensureChunkAreasDoNotOverlap,
  resolveQuotaForArea,
  activateRoundWithSnapshot,
  activateDueChunksForRound,
  getRoundBySubmissionForEvaluation,
  recalculateSubmissionAverageForRound,
  refreshSubmissionAndAreaLeaderboard,
  getAreaReadiness,
  approveAreaLeaderboardAndPromote,
  publishAreaLeaderboard,
  reopenAreaLeaderboard,
  listAreaLeaderboards,
  listCouncilAreaLeaderboards,
  listAvailableLocations,
  findAreaLeaderboardById,
  getAreaIdFromSubmission,
  markRoundEndedIfComplete,
  rebuildAreaLeaderboard,
  updateAreaStateByCompletion,
  checkAreaJudgeCompletion,
  addSubmissionToActiveRoundSnapshot,
  discoverMissingLeaderboardAreas
};
