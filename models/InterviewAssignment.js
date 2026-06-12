const mongoose = require('mongoose');

/**
 * InterviewAssignment Model
 *
 * Tracks the separate National interview panel for a submission.
 * These judges do not have to be the same judges who evaluated the video.
 */
const interviewAssignmentSchema = new mongoose.Schema({
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
  assignedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  },
  assignedAt: {
    type: Date,
    default: Date.now
  }
}, {
  timestamps: true
});

interviewAssignmentSchema.index({ roundId: 1, judgeId: 1 });
interviewAssignmentSchema.index({ roundId: 1, submissionId: 1 });
interviewAssignmentSchema.index(
  { roundId: 1, submissionId: 1, judgeId: 1 },
  { unique: true }
);

module.exports = mongoose.model('InterviewAssignment', interviewAssignmentSchema);
