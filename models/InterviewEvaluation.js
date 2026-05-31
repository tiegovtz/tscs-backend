const mongoose = require('mongoose');

const interviewEvaluationSchema = new mongoose.Schema({
  year: {
    type: Number,
    required: true,
    index: true
  },
  level: {
    type: String,
    enum: ['National'],
    required: true,
    default: 'National',
    index: true
  },
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
  score: {
    type: Number,
    required: true,
    min: 0,
    max: 100
  },
  comments: {
    type: String,
    default: ''
  },
  submittedAt: {
    type: Date,
    default: Date.now
  }
}, {
  timestamps: true
});

interviewEvaluationSchema.index(
  { roundId: 1, submissionId: 1, judgeId: 1 },
  { unique: true }
);
interviewEvaluationSchema.index({ submissionId: 1, submittedAt: -1 });
interviewEvaluationSchema.index({ judgeId: 1, submittedAt: -1 });

module.exports = mongoose.model('InterviewEvaluation', interviewEvaluationSchema);
