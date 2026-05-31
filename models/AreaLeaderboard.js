const mongoose = require('mongoose');

const areaLeaderboardEntrySchema = new mongoose.Schema({
  submissionId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Submission',
    required: true
  },
  teacherId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  teacherName: {
    type: String,
    required: true
  },
  teacherEmail: {
    type: String,
    default: ''
  },
  school: {
    type: String,
    required: true
  },
  region: {
    type: String,
    default: null
  },
  council: {
    type: String,
    default: null
  },
  category: {
    type: String,
    required: true
  },
  class: {
    type: String,
    required: true
  },
  subject: {
    type: String,
    required: true
  },
  areaOfFocus: {
    type: String,
    required: true
  },
  rank: {
    type: Number,
    required: true
  },
  averageScore: {
    type: Number,
    default: 0
  },
  totalScore: {
    type: Number,
    default: 0
  },
  totalEvaluations: {
    type: Number,
    default: 0
  },
  submissionAverageScore: {
    type: Number,
    default: null
  },
  submissionMaxScore: {
    type: Number,
    default: null
  },
  videoWeightedScore: {
    type: Number,
    default: null
  },
  interviewAverageScore: {
    type: Number,
    default: null
  },
  interviewTotalEvaluations: {
    type: Number,
    default: 0
  },
  interviewWeightedScore: {
    type: Number,
    default: null
  },
  finalScore: {
    type: Number,
    default: null
  },
  status: {
    type: String,
    enum: ['pending', 'evaluated', 'promoted', 'eliminated', 'disqualified'],
    default: 'pending'
  },
  tieBreakCreatedAt: {
    type: Date,
    default: null
  }
}, { _id: false });

const areaLeaderboardSchema = new mongoose.Schema({
  roundId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'CompetitionRound',
    required: true,
    index: true
  },
  year: {
    type: Number,
    required: true
  },
  level: {
    type: String,
    enum: ['Council', 'Regional', 'National'],
    required: true
  },
  areaType: {
    type: String,
    enum: ['council', 'region', 'national'],
    required: true
  },
  areaId: {
    type: String,
    required: true,
    trim: true
  },
  region: {
    type: String,
    default: null
  },
  council: {
    type: String,
    default: null
  },
  chunkIds: {
    type: [mongoose.Schema.Types.ObjectId],
    ref: 'RoundChunk',
    default: []
  },
  state: {
    type: String,
    enum: ['provisional', 'awaiting_superadmin_approval', 'finalized', 'published'],
    default: 'provisional'
  },
  entries: {
    type: [areaLeaderboardEntrySchema],
    default: []
  },
  totalSubmissions: {
    type: Number,
    default: 0
  },
  totalEvaluations: {
    type: Number,
    default: 0
  },
  quota: {
    type: Number,
    default: 0
  },
  isLocked: {
    type: Boolean,
    default: false
  },
  finalizedAt: {
    type: Date,
    default: null
  },
  finalizedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    default: null
  },
  publishedAt: {
    type: Date,
    default: null
  },
  publishedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    default: null
  },
  publishedAudiences: {
    type: [String],
    enum: ['judges', 'teachers'],
    default: []
  },
  publishedVersion: {
    type: Number,
    default: 0
  },
  lastUpdated: {
    type: Date,
    default: Date.now
  },
  metadata: {
    type: mongoose.Schema.Types.Mixed,
    default: {}
  }
}, {
  timestamps: true
});

areaLeaderboardSchema.index({ roundId: 1, level: 1, areaType: 1, areaId: 1 }, { unique: true });
areaLeaderboardSchema.index({ roundId: 1, state: 1 });
areaLeaderboardSchema.index({ state: 1, publishedAt: -1 });
areaLeaderboardSchema.index({ level: 1, areaType: 1, areaId: 1 });
areaLeaderboardSchema.index({ roundId: 1, chunkIds: 1 });

module.exports = mongoose.model('AreaLeaderboard', areaLeaderboardSchema);
