const mongoose = require('mongoose');

/**
 * SubmissionAssignment Model
 * 
 * Tracks judge-submission assignments for all levels.
 * Council/Regional keep one current judge per submission per round.
 * National allows multiple judges to evaluate the same submission.
 */
const submissionAssignmentSchema = new mongoose.Schema({
  roundId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'CompetitionRound',
    required: true,
    index: true
  },
  submissionId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Submission',
    required: true,
    index: true
  },
  judgeId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true
  },
  level: {
    type: String,
    enum: ['Council', 'Regional', 'National'],
    required: true
  },
  region: {
    type: String,
    required: function requireRegionForScopedAssignment() {
      return this.level !== 'National';
    },
    trim: true
  },
  council: {
    type: String,
    trim: true
  },
  assignedAt: {
    type: Date,
    default: Date.now
  },
  // Track if judge has been notified
  judgeNotified: {
    type: Boolean,
    default: false
  }
}, {
  timestamps: true
});

// Compound indexes for efficient queries
submissionAssignmentSchema.index({ roundId: 1, judgeId: 1, level: 1 });
submissionAssignmentSchema.index({ roundId: 1, submissionId: 1 });
submissionAssignmentSchema.index({ roundId: 1, submissionId: 1, judgeId: 1 }, { unique: true });
submissionAssignmentSchema.index(
  { roundId: 1, submissionId: 1, level: 1 },
  {
    unique: true,
    partialFilterExpression: { level: { $in: ['Council', 'Regional'] } }
  }
);
submissionAssignmentSchema.index({ roundId: 1, level: 1, region: 1, council: 1 });

module.exports = mongoose.model('SubmissionAssignment', submissionAssignmentSchema);















