const CompetitionRound = require('../models/CompetitionRound');

const ACTIONABLE_ROUND_STATUSES = ['active', 'ended'];
const HISTORICAL_ROUND_STATUSES = ['closed', 'archived'];

const STATUS_PRIORITY = {
  active: 4,
  ended: 3,
  closed: 2,
  archived: 1,
  pending: 0,
  draft: -1
};

const escapeRegex = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const normalizeLocationValue = (value) => {
  if (value === null || value === undefined) return '';
  return String(value).trim().toLowerCase();
};

const locationsEqual = (left, right) => normalizeLocationValue(left) === normalizeLocationValue(right);

const buildCaseInsensitiveExactRegex = (value) => {
  const normalized = String(value || '').trim();
  if (!normalized) return null;
  return new RegExp(`^${escapeRegex(normalized)}$`, 'i');
};

const isRoundActionable = (round) => !!round && ACTIONABLE_ROUND_STATUSES.includes(round.status);
const isRoundHistorical = (round) => !!round && HISTORICAL_ROUND_STATUSES.includes(round.status);

const sortRoundsByPriority = (rounds = []) => {
  return [...rounds].sort((a, b) => {
    const statusDiff = (STATUS_PRIORITY[b.status] || -10) - (STATUS_PRIORITY[a.status] || -10);
    if (statusDiff !== 0) return statusDiff;
    return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
  });
};

const roundMatchesSubmission = (round, submission) => {
  if (!round || !submission) return false;
  if (submission.level && round.level !== submission.level) return false;
  if (submission.year && Number(round.year) !== Number(submission.year)) return false;
  return true;
};

const getRoundStatusFilter = ({ includeHistorical = false } = {}) => {
  return includeHistorical
    ? [...ACTIONABLE_ROUND_STATUSES, ...HISTORICAL_ROUND_STATUSES]
    : [...ACTIONABLE_ROUND_STATUSES];
};

const findRoundsByLevel = async ({
  level,
  year = null,
  includeHistorical = false,
  includeFaceToFace = false
}) => {
  if (!level) return [];
  const query = {
    level,
    status: { $in: getRoundStatusFilter({ includeHistorical }) }
  };
  if (!includeFaceToFace) {
    query.stage = { $ne: 'face_to_face' };
  }
  if (year !== null && year !== undefined && Number.isFinite(Number(year))) {
    query.year = Number(year);
  }
  const rounds = await CompetitionRound.find(query).select('_id year level stage status createdAt endTime');
  return sortRoundsByPriority(rounds);
};

const getActionableRoundIdsForLevel = async ({
  level,
  year = null,
  includeFaceToFace = false
}) => {
  const rounds = await findRoundsByLevel({
    level,
    year,
    includeHistorical: false,
    includeFaceToFace
  });
  return rounds.map((round) => round._id);
};

const resolveSubmissionRoundContext = async (submission, options = {}) => {
  const {
    explicitRoundId = null,
    includeHistorical = false,
    allowFallbackByYearLevel = true,
    includeFaceToFace = false
  } = options;

  const allowedStatuses = getRoundStatusFilter({ includeHistorical });

  if (explicitRoundId) {
    const explicitRound = await CompetitionRound.findById(explicitRoundId);
    if (!explicitRound) {
      return {
        round: null,
        source: 'explicit',
        reason: 'explicit_round_not_found'
      };
    }

    if (!includeFaceToFace && explicitRound.stage === 'face_to_face') {
      if (allowFallbackByYearLevel) {
        const fallbackRounds = await findRoundsByLevel({
          level: submission?.level || explicitRound.level,
          year: submission?.year || explicitRound.year,
          includeHistorical,
          includeFaceToFace
        });
        const fallbackRound = fallbackRounds[0] || null;
        if (fallbackRound) {
          return {
            round: fallbackRound,
            source: 'fallback',
            reason: null,
            rejectedRound: explicitRound,
            rejectedReason: 'explicit_round_stage_not_allowed'
          };
        }
      }

      return {
        round: null,
        source: 'explicit',
        reason: 'explicit_round_stage_not_allowed',
        rejectedRound: explicitRound
      };
    }

    if (submission && !roundMatchesSubmission(explicitRound, submission)) {
      if (allowFallbackByYearLevel) {
        const fallbackRounds = await findRoundsByLevel({
          level: submission.level,
          year: submission.year,
          includeHistorical,
          includeFaceToFace
        });
        const fallbackRound = fallbackRounds[0] || null;
        if (fallbackRound) {
          return {
            round: fallbackRound,
            source: 'fallback',
            reason: null,
            rejectedRound: explicitRound,
            rejectedReason: 'explicit_round_submission_mismatch'
          };
        }
      }

      return {
        round: null,
        source: 'explicit',
        reason: 'explicit_round_submission_mismatch',
        rejectedRound: explicitRound
      };
    }

    if (!allowedStatuses.includes(explicitRound.status)) {
      return {
        round: null,
        source: 'explicit',
        reason: 'explicit_round_not_allowed',
        rejectedRound: explicitRound
      };
    }

    return {
      round: explicitRound,
      source: 'explicit',
      reason: null
    };
  }

  if (submission?.roundId) {
    const submissionRound = await CompetitionRound.findById(submission.roundId);
    if (submissionRound && roundMatchesSubmission(submissionRound, submission)) {
      if (!includeFaceToFace && submissionRound.stage === 'face_to_face') {
        if (!allowFallbackByYearLevel) {
          return {
            round: null,
            source: 'submission',
            reason: 'submission_round_stage_not_allowed',
            rejectedRound: submissionRound
          };
        }
      } else if (allowedStatuses.includes(submissionRound.status)) {
        return {
          round: submissionRound,
          source: 'submission',
          reason: null
        };
      } else if (!allowFallbackByYearLevel) {
        return {
          round: null,
          source: 'submission',
          reason: 'submission_round_not_allowed',
          rejectedRound: submissionRound
        };
      }

      if (!allowFallbackByYearLevel) {
        return {
          round: null,
          source: 'submission',
          reason: 'submission_round_not_allowed',
          rejectedRound: submissionRound
        };
      }
    }
  }

  if (allowFallbackByYearLevel && submission?.level && submission?.year) {
    const fallbackRounds = await findRoundsByLevel({
      level: submission.level,
      year: submission.year,
      includeHistorical,
      includeFaceToFace
    });
    const fallbackRound = fallbackRounds[0] || null;
    if (fallbackRound) {
      return {
        round: fallbackRound,
        source: 'fallback',
        reason: null
      };
    }
  }

  return {
    round: null,
    source: 'none',
    reason: 'round_not_found'
  };
};

module.exports = {
  ACTIONABLE_ROUND_STATUSES,
  HISTORICAL_ROUND_STATUSES,
  normalizeLocationValue,
  locationsEqual,
  buildCaseInsensitiveExactRegex,
  isRoundActionable,
  isRoundHistorical,
  roundMatchesSubmission,
  sortRoundsByPriority,
  findRoundsByLevel,
  getActionableRoundIdsForLevel,
  resolveSubmissionRoundContext
};
